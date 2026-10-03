import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/*
 * More, shorter sections.
 *
 * 72 sections over 6.5 turns gives 11.08 sections/turn.
 * Each section is itself a small curved piece of the helix.
 *
 * Section count is doubled relative to the original (36 -> 72).
 * Since the coil's axial length is SECTION_COUNT * COIL_PITCH,
 * doubling the section count while leaving COIL_PITCH untouched
 * doubles the solenoid's length for free. COIL_TURNS is doubled
 * alongside it (3.25 -> 6.5) so the coil is twice as long with
 * twice as many turns at the same winding density (same
 * sections-per-turn, same physical pitch).
 */
const SECTION_COUNT = 72;
const SECTION_LENGTH = 0.52;
const TAIL_PULL_RATIO = 0.75;

const COIL_RADIUS = 1.75;
const COIL_PITCH = 0.1;
const COIL_TURNS = 6.5;
const PULSE_REPEAT_TURNS = 3;

// Number of points used to actually curve each wire section.
const SECTION_CURVE_SAMPLES = 8;

// While wrapping, the field lines are rebuilt every frame using every
// Nth curve sample per section for the field sum (cheaper, slightly
// coarser). The full-resolution field is rebuilt when the animation ends.
const ANIMATED_FIELD_STRIDE = 2;

// Wrap/unwrap animation length grows gently with the number of sections
// moved: one section takes WRAP_BASE_MS, each extra section adds
// WRAP_MS_PER_EXTRA_SECTION, capped at WRAP_MAX_MS (72 sections -> 3.5 s).
const WRAP_BASE_MS = 1720;
const WRAP_MS_PER_EXTRA_SECTION = 25;
const WRAP_MAX_MS = 3500;

function wrapDurationMs(sectionsMoved) {
  return Math.min(
    WRAP_MAX_MS,
    WRAP_BASE_MS +
      WRAP_MS_PER_EXTRA_SECTION *
        Math.max(0, sectionsMoved - 1),
  );
}

function lerpVec3(a, b, t) {
  return new THREE.Vector3().lerpVectors(a, b, t);
}

/*
 * The coil is parameterized by x rather than theta.
 *
 * x advances along the axis while y/z trace the circular winding.
 */
function coilPointAt(
  t,
  pitch = COIL_PITCH,
) {
  const totalLength =
    SECTION_COUNT * pitch;

  const x =
    -totalLength / 2 +
    t * totalLength;

  const theta =
    t * Math.PI * 2 * COIL_TURNS;

  return new THREE.Vector3(
    x,
    COIL_RADIUS * Math.sin(theta),
    COIL_RADIUS * (1 - Math.cos(theta)),
  );
}

/*
 * Straight wire is kept as a useful intermediate state for the
 * sections that have not yet been wrapped.
 */
const STRAIGHT_OFFSET = new THREE.Vector3(
  15, // X
  0,  // Y
  -3, // Z
);

function makeStraightPoint(index, tailPull = 0) {
  const total =
    SECTION_COUNT * SECTION_LENGTH;

  return new THREE.Vector3(
    -total / 2 +
      index * SECTION_LENGTH -
      tailPull,
    0,
    0,
  ).add(STRAIGHT_OFFSET);
}

/*
 * Return the actual curved path for ONE wrapped section.
 *
 * A wrapped section isn't a straight cylinder between two helix
 * points. It contains several points along the helix.
 */
function getCurvedSectionPoints(
  sectionIndex,
  pitch = COIL_PITCH,
) {
  const points = [];

  for (
    let i = 0;
    i <= SECTION_CURVE_SAMPLES;
    i++
  ) {
    const localT =
      i / SECTION_CURVE_SAMPLES;

    const globalT =
      (sectionIndex + localT) /
      SECTION_COUNT;

    points.push(
      coilPointAt(
        globalT,
        pitch,
      ),
    );
  }

  return points;
}

/*
 * Get the geometry points for an individual section.
 *
 * IMPORTANT:
 *
 * `animatedWrap` is authoritative during an animation.
 *
 * 0   = completely straight
 * 0-1 = smoothly morphing straight -> curved
 * 1   = completely wrapped
 */
function getSectionPath(
  sectionIndex,
  animatedWrap = 1,
  pitch = COIL_PITCH,
  tailPull = 0,
) {
  const straightA =
    makeStraightPoint(
      sectionIndex,
      tailPull,
    );

  const straightB =
    makeStraightPoint(
      sectionIndex + 1,
      tailPull,
    );

  /*
   * Completely unwrapped.
   */
  if (animatedWrap <= 0) {
    return [
      straightA,
      straightB,
    ];
  }

  /*
   * Completely wrapped.
   */
  const curved =
    getCurvedSectionPoints(
      sectionIndex,
      pitch,
    );

  if (animatedWrap >= 1) {
    return curved;
  }

  /*
   * Smoothly morph every point in the section
   * from its straight position to its final
   * curved helix position.
   */
  return curved.map((coilP, i) => {
    const localT =
      i / SECTION_CURVE_SAMPLES;

    const straightP =
      straightA.clone().lerp(
        straightB,
        localT,
      );

    return lerpVec3(
      straightP,
      coilP,
      animatedWrap,
    );
  });
}

/*
 * Return every section's path.
 */
function getAllSectionPaths(
  wrappedCount,
  pitch = COIL_PITCH,
  tailPull = 0,
) {
  return Array.from(
    { length: SECTION_COUNT },
    (_, i) =>
      getSectionPath(
        i,
        i < wrappedCount ? 1 : 0,
        pitch,
        tailPull,
      ),
  );
}

/*
 * Animate any range of sections at once.
 *
 * For example:
 *
 * 0 -> 4:
 *   sections 1-4 all curl simultaneously.
 *
 * 3 -> 18:
 *   sections 1-3 stay wrapped while
 *   sections 4-18 curl simultaneously.
 *
 * 18 -> 3:
 *   sections 4-18 uncurl simultaneously.
 */
function getAnimatedSectionPaths(
  fromCount,
  toCount,
  t,
  pitch = COIL_PITCH,
  previousPaths,
  tailPull = 0,
) {
  const low = Math.min(fromCount, toCount);
  const high = Math.max(fromCount, toCount);
  const changingWrap =
    toCount > fromCount ? t : 1 - t;

  const paths = [];

  for (let i = 0; i < SECTION_COUNT; i++) {
    // Sections that stay wrapped can reuse their existing path.
    if (previousPaths && i < low) {
      paths.push(previousPaths[i]);
      continue;
    }

    const wrapAmount =
      i < low
        ? 1
        : i < high
          ? changingWrap
          : 0;

    paths.push(
      getSectionPath(
        i,
        wrapAmount,
        pitch,
        tailPull,
      ),
    );
  }

  return paths;
}

function disposeObject(root) {
  root.traverse((obj) => {
    if (obj.geometry) {
      obj.geometry.dispose();
    }

    if (obj.material) {
      const materials =
        Array.isArray(obj.material)
          ? obj.material
          : [obj.material];

      materials.forEach((mat) =>
        mat.dispose(),
      );
    }
  });
}

/*
 * Make a straight cylinder for an unwrapped section.
 */
function createCylinderBetween(
  a,
  b,
  radius,
  material,
) {
  const direction =
    new THREE.Vector3().subVectors(
      b,
      a,
    );

  const length =
    direction.length();

  const geometry =
    new THREE.CylinderGeometry(
      radius,
      radius,
      length,
      12,
    );

  const mesh =
    new THREE.Mesh(
      geometry,
      material,
    );

  mesh.position
    .copy(a)
    .add(b)
    .multiplyScalar(0.5);

  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.normalize(),
  );

  return mesh;
}

/*
 * Make a genuinely curved tube for a wrapped section.
 */
function createCurvedWire(
  points,
  radius,
  material,
) {
  const curve =
    new THREE.CatmullRomCurve3(
      points,
      false,
      'centripetal',
    );

  const geometry =
    new THREE.TubeGeometry(
      curve,
      Math.max(
        8,
        points.length * 2,
      ),
      radius,
      10,
      false,
    );

  return new THREE.Mesh(
    geometry,
    material,
  );
}

/*
 * Draw a field ring around an arbitrary local wire direction.
 */
function makeFieldRing(
  center,
  axis,
  radius,
  color,
  opacity = 0.55,
  segments = 72,
) {
  const dir =
    axis.clone().normalize();

  const helper =
    Math.abs(
      dir.dot(
        new THREE.Vector3(
          0,
          1,
          0,
        ),
      ),
    ) > 0.85
      ? new THREE.Vector3(
          1,
          0,
          0,
        )
      : new THREE.Vector3(
          0,
          1,
          0,
        );

  const u =
    new THREE.Vector3()
      .crossVectors(
        dir,
        helper,
      )
      .normalize();

  const v =
    new THREE.Vector3()
      .crossVectors(
        dir,
        u,
      )
      .normalize();

  // ----------------------------------------
  // Ring
  // ----------------------------------------

  const positions = [];

  for (
    let i = 0;
    i <= segments;
    i++
  ) {
    const theta =
      (i / segments) *
      Math.PI *
      2;

    const p =
      center
        .clone()
        .addScaledVector(
          u,
          Math.cos(theta) *
            radius,
        )
        .addScaledVector(
          v,
          Math.sin(theta) *
            radius,
        );

    positions.push(
      p.x,
      p.y,
      p.z,
    );
  }

  const geometry =
    new THREE.BufferGeometry();

  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      positions,
      3,
    ),
  );

  const material =
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });

  const ring =
    new THREE.Line(
      geometry,
      material,
    );

  // ----------------------------------------
  // Two arrows
  // ----------------------------------------

  const arrowMaterial =
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });

  const arrowGeometry =
    new THREE.ConeGeometry(
      radius * 0.10,
      radius * 0.30,
      8,
    );

  const arrowAngles = [
    Math.PI / 2,
    Math.PI * 1.5,
  ];

  const arrows = [];

  arrowAngles.forEach(
    (theta) => {
      const arrowPosition =
        center
          .clone()
          .addScaledVector(
            u,
            Math.cos(theta) *
              radius,
          )
          .addScaledVector(
            v,
            Math.sin(theta) *
              radius,
          );

      const arrowDirection =
        new THREE.Vector3()
          .addScaledVector(
            u,
            -Math.sin(theta),
          )
          .addScaledVector(
            v,
            Math.cos(theta),
          )
          .normalize();

      const arrow =
        new THREE.Mesh(
          arrowGeometry,
          arrowMaterial,
        );

      arrow.position.copy(
        arrowPosition,
      );

      arrow.quaternion.setFromUnitVectors(
        new THREE.Vector3(
          0,
          1,
          0,
        ),
        arrowDirection,
      );

      arrows.push(arrow);
    },
  );

  const group =
    new THREE.Group();

  group.add(ring);

  arrows.forEach((arrow) =>
    group.add(arrow),
  );

  return group;
}

/*
 * Flatten the wire into a packed list of straight current elements
 * (midpoint xyz, dl xyz) so the Biot-Savart sum below is plain
 * arithmetic with no per-step Vector3 allocations.
 *
 * `stride` > 1 skips intermediate curve samples, giving a coarser
 * but much cheaper approximation (used while animating).
 *
 * `weightOf(i)` scales section i's current. During a wrap animation
 * the sections being added/removed are weighted by how far they have
 * curled, so the field fades smoothly instead of jumping.
 */
function buildCurrentElements(
  sectionPaths,
  activeCount,
  stride = 1,
  weightOf = () => 1,
) {
  const values = [];

  for (let s = 0; s < activeCount; s++) {
    const weight = weightOf(s);

    if (weight <= 0) {
      continue;
    }

    const path = sectionPaths[s];
    const last = path.length - 1;

    for (let j = 0; j < last; j += stride) {
      const a = path[j];
      const b = path[Math.min(j + stride, last)];

      values.push(
        (a.x + b.x) * 0.5,
        (a.y + b.y) * 0.5,
        (a.z + b.z) * 0.5,
        (b.x - a.x) * weight,
        (b.y - a.y) * weight,
        (b.z - a.z) * weight,
      );
    }
  }

  return new Float64Array(values);
}

/*
 * Approximate Biot-Savart field at (px, py, pz) from packed current
 * elements. Writes the result into `out` and returns it.
 */
function fieldAt(px, py, pz, elements, out) {
  let bx = 0;
  let by = 0;
  let bz = 0;

  for (let k = 0; k < elements.length; k += 6) {
    const rx = px - elements[k];
    const ry = py - elements[k + 1];
    const rz = pz - elements[k + 2];
    const dx = elements[k + 3];
    const dy = elements[k + 4];
    const dz = elements[k + 5];

    let rSq = rx * rx + ry * ry + rz * rz;

    if (rSq < 0.035) {
      rSq = 0.035;
    }

    const inv = 1 / (rSq * Math.sqrt(rSq));

    bx += (dy * rz - dz * ry) * inv;
    by += (dz * rx - dx * rz) * inv;
    bz += (dx * ry - dy * rx) * inv;
  }

  return out.set(bx, by, bz);
}

/*
 * Trace a field line through the combined field.
 */
function traceCombinedStreamline(
  seed,
  directionSign,
  elements,
) {
  const linePoints = [];
  const p = seed.clone();
  const b = new THREE.Vector3();

  for (
    let step = 0;
    step < 150;
    step++
  ) {
    linePoints.push(
      p.clone(),
    );

    fieldAt(p.x, p.y, p.z, elements, b);

    const magnitude =
      b.length();

    if (
      !Number.isFinite(
        magnitude,
      ) ||
      magnitude < 0.0005
    ) {
      break;
    }

    p.addScaledVector(
      b,
      (directionSign * 0.14) / magnitude,
    );

    if (
      Math.abs(p.x) > 13 ||
      Math.abs(p.y) > 10 ||
      Math.abs(p.z) > 12
    ) {
      break;
    }
  }

  return linePoints;
}

/*
 * Add directional arrows along a traced field line.
 */
function addStreamlineArrows(
  group,
  points,
  color,
  spacing = 12,
  arrowLength = 0.24,
  arrowWidth = 0.10,
  opacity = 0.8,
) {
  if (points.length < 3) {
    return;
  }

  const arrowMaterial =
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });

  const arrowGeometry =
    new THREE.ConeGeometry(
      arrowWidth,
      arrowLength,
      8,
    );

  for (
    let i = spacing;
    i < points.length - 1;
    i += spacing
  ) {
    const position =
      points[i];

    const direction =
      new THREE.Vector3()
        .subVectors(
          points[i + 1],
          points[i - 1],
        )
        .normalize();

    const arrow =
      new THREE.Mesh(
        arrowGeometry,
        arrowMaterial,
      );

    arrow.position.copy(
      position,
    );

    arrow.quaternion.setFromUnitVectors(
      new THREE.Vector3(
        0,
        1,
        0,
      ),
      direction,
    );

    group.add(arrow);
  }
}

/*
 * Combined-field view.
 *
 * options:
 *   pitch     - coil pitch, used to place seeds along the finished helix
 *   seedSpan  - how many sections' worth of coil to spread seeds over
 *               (may be fractional mid-animation; defaults to activeCount)
 *   stride    - curve-sample stride for the field sum (see above)
 *   weightOf  - per-section current weight (see above)
 */
function buildCombinedField(
  sectionPaths,
  activeCount,
  lineCount = 18,
  {
    pitch = COIL_PITCH,
    seedSpan = activeCount,
    stride = 1,
    weightOf,
  } = {},
) {
  const group =
    new THREE.Group();

  if (activeCount <= 0 || seedSpan <= 0) {
    return group;
  }

  const elements =
    buildCurrentElements(
      sectionPaths,
      activeCount,
      stride,
      weightOf,
    );

  /*
   * Seed the requested number of lines at evenly-spaced axial positions
   * and around the coil axis.  Alternating inner/outer seed radii gives
   * the combined field a useful mix of lines through the solenoid and
   * return lines outside it, while the golden-angle rotation avoids the
   * visible three-cluster pattern of the old fixed seed set.
   *
   * Seeds are spread continuously along the finished helix (not
   * snapped to section centres), so as `seedSpan` changes during a wrap
   * every seed slides smoothly on every frame instead of stepping a
   * whole section at a time.
   */
  const seeds = [];
  const count = Math.max(1, Math.round(lineCount));
  const axisCenterZ = COIL_RADIUS;
  const goldenAngle =
    Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < count; i++) {
    const axialFraction =
      count === 1
        ? 0.5
        : (i + 0.5) / count;

    const centerX =
      coilPointAt(
        (axialFraction * seedSpan) / SECTION_COUNT,
        pitch,
      ).x;

    const angle =
      i * goldenAngle;

    const radius =
      i % 2 === 0
        ? Math.min(1.35, COIL_RADIUS * 0.72)
        : COIL_RADIUS + 0.85;

    seeds.push(
      new THREE.Vector3(
        centerX,
        Math.cos(angle) * radius,
        axisCenterZ +
          Math.sin(angle) * radius,
      ),
    );
  }

  const colors = [
    0x4de4ff,
    0x68b5ff,
    0x8c7bff,
  ];

  seeds.forEach(
    (seed, seedIndex) => {
      const forward =
        traceCombinedStreamline(
          seed,
          1,
          elements,
        );

      const backward =
        traceCombinedStreamline(
          seed,
          -1,
          elements,
        );

      const traced = [
        ...backward.reverse().slice(0, -1),
        ...forward,
      ];

      if (traced.length < 8) {
        return;
      }

      const geometry =
        new THREE.BufferGeometry()
          .setFromPoints(
            traced,
          );

      const color =
        colors[
          seedIndex %
            colors.length
        ];

      const material =
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.45,
          depthWrite: false,
        });

      group.add(
        new THREE.Line(
          geometry,
          material,
        ),
      );

      addStreamlineArrows(
        group,
        traced,
        color,
        12,
        0.24,
        0.10,
        0.8,
      );
    },
  );

  return group;
}

/*
 * Every section gets its own independent field visualization.
 */
function buildAllContributionsField(
  sectionPaths,
  sectionIndices,
) {
  const group =
    new THREE.Group();

  const palette = [
    0xff5f8f,
    0xff8b5f,
    0xffc857,
    0xb7df65,
    0x55d6a4,
    0x4dd9d9,
    0x55a8ff,
    0x7775ff,
    0xb875ff,
    0xee72ff,
  ];

  for (
    let sectionIndex = 0;
    sectionIndex < SECTION_COUNT;
    sectionIndex++
  ) {
    if (
      sectionIndices &&
      !sectionIndices.includes(
        sectionIndex,
      )
    ) {
      continue;
    }

    const sectionGroup =
      new THREE.Group();

    sectionGroup.userData.sectionIndex =
      sectionIndex;

    const sectionPath =
      sectionPaths[
        sectionIndex
      ];

    const color =
      palette[
        sectionIndex %
          palette.length
      ];

    const center =
      new THREE.Vector3();

    sectionPath.forEach((p) =>
      center.add(p),
    );

    center.multiplyScalar(
      1 / sectionPath.length,
    );

    const tangent =
      new THREE.Vector3()
        .subVectors(
          sectionPath[
            sectionPath.length - 1
          ],
          sectionPath[0],
        )
        .normalize();

    [
      0.25,
      0.45,
      0.60,
    ].forEach(
      (radius, ringIndex) => {
        sectionGroup.add(
          makeFieldRing(
            center,
            tangent,
            radius,
            color,
            1.42 -
              ringIndex * 0.08,
            56,
          ),
        );
      },
    );

    group.add(sectionGroup);
  }

  return group;
}

/*
 * Isolated field for currently-selected section(s).
 */
function buildSectionField(
  sectionPaths,
  sectionIndices,
) {
  const group =
    new THREE.Group();

  const validIndices =
    (sectionIndices || []).filter(
      (idx) =>
        idx != null &&
        idx >= 0 &&
        idx < sectionPaths.length,
    );

  if (
    validIndices.length === 0
  ) {
    return group;
  }

  validIndices.forEach(
    (sectionIndex) => {
      const sectionPath =
        sectionPaths[
          sectionIndex
        ];

      const center =
        new THREE.Vector3();

      sectionPath.forEach((p) =>
        center.add(p),
      );

      center.multiplyScalar(
        1 / sectionPath.length,
      );

      const tangent =
        new THREE.Vector3()
          .subVectors(
            sectionPath[
              sectionPath.length - 1
            ],
            sectionPath[0],
          )
          .normalize();

      [
        0.8,
        1.15,
        1.55,
        2.0,
      ].forEach(
        (radius, idx) => {
          group.add(
            makeFieldRing(
              center,
              tangent,
              radius,
              0xff76da,
              0.78 -
                idx * 0.11,
              72,
            ),
          );
        },
      );

      const arrow =
        new THREE.ArrowHelper(
          tangent,
          center
            .clone()
            .addScaledVector(
              tangent,
              -0.2,
            ),
          0.85,
          0xff9ce7,
          0.18,
          0.11,
        );

      group.add(arrow);
    },
  );

  return group;
}

const DIRECTION_ARROW_PATHS = {
  up: 'M12 19 V5 M7 10 L12 5 L17 10',
  right: 'M5 12 H19 M14 7 L19 12 L14 17',
  down: 'M12 5 V19 M7 14 L12 19 L17 14',
  left: 'M19 12 H5 M10 7 L5 12 L10 17',
};

function DirectionArrow({ direction }) {
  const path =
    DIRECTION_ARROW_PATHS[direction];

  return (
    <svg
      className="direction-arrow"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        className="direction-arrow-shadow"
        d={path}
      />
      <path
        className="direction-arrow-face"
        d={path}
      />
      <path
        className="direction-arrow-highlight"
        d={path}
      />
    </svg>
  );
}

function SliderField({
  label,
  valueText,
  value,
  min,
  max,
  step,
  onChange,
  disabled = false,
  disabledHint,
}) {
  const fraction =
    (value - min) / (max - min);

  return (
    <label
      className={`slider-field${
        disabled ? ' is-disabled' : ''
      }`}
      title={disabled ? disabledHint : undefined}
    >
      <span className="slider-head">
        <span className="slider-label">
          {label}
        </span>

        <span className="slider-value">
          {valueText}
        </span>
      </span>

      <input
        className="slider-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onChange}
        disabled={disabled}
        style={{
          '--fill': Math.min(
            1,
            Math.max(0, fraction),
          ),
        }}
      />
    </label>
  );
}

function FieldLegend({
  selectedSections,
  wrappedCount,
  mode,
}) {
  let title =
    'Combined field';

  let description =
    `${wrappedCount} section${
      wrappedCount === 1
        ? ''
        : 's'
    } contributing`;

  if (mode === 'all') {
    title =
      'Individual contributions';

    description =
      'All sections shown independently';
  }

  if (mode === 'individual') {
    const labels =
      (
        selectedSections || []
      ).map((i) => i + 1);

    title =
      labels.length === 2
        ? `Fields from sections ${labels[0]} & ${labels[1]}`
        : `Field from section ${
            labels[0] ?? 1
          }`;

    description =
      labels.length === 2
        ? 'The two selected sections, shown together'
        : 'Only the selected section contributes';
  }

  if (mode === 'none') {
    title =
      'No field shown';

    description =
      'The magnetic field visualization is hidden';
  }

  return (
    <div className="field-legend">
      <div className="legend-title">
        {title}
      </div>

      <div className="legend-row">
        <span
          className={`legend-dot ${
            mode === 'combined'
              ? 'cyan'
              : mode === 'all'
                ? 'rainbow'
                : mode === 'individual'
                  ? 'pink'
                  : ''
          }`}
        />

        <span>
          {description}
        </span>
      </div>
    </div>
  );
}

export default function App() {
  const mountRef =
    useRef(null);

  const webglFallbackRef =
    useRef(null);

  const [
    wrappedCount,
    setWrappedCount,
  ] = useState(0);

  const [
    selectedSections,
    setSelectedSections,
  ] = useState([]);

  const [mode, setMode] =
    useState('combined');

  const [showCurrent, setShowCurrent] =
    useState(true);

  const [showPoles, setShowPoles] =
    useState(false);

  const stateRef =
    useRef({
      wrappedCount: 0,
      selectedSections: [],
      mode: 'combined',
      combinedLineCount: 18,
    });

  const [coilPitch, setCoilPitch] =
    useState(COIL_PITCH);

  const [combinedLineCount, setCombinedLineCount] =
    useState(18);

  const coilPitchRef =
    useRef(COIL_PITCH);

  coilPitchRef.current =
    coilPitch;

  stateRef.current.wrappedCount =
    wrappedCount;

  stateRef.current.selectedSections =
    selectedSections;

  stateRef.current.mode =
    mode;

  stateRef.current.combinedLineCount =
    combinedLineCount;

  useEffect(() => {
    const mount =
      mountRef.current;

    if (!mount) {
      return undefined;
    }

    const scene =
      new THREE.Scene();

    scene.background =
      new THREE.Color(
        0x07111b,
      );

    const camera =
      new THREE.PerspectiveCamera(
        43,
        1,
        0.1,
        100,
      );

    camera.position.set(
      10.5,
      8.2,
      12.5,
    );

    let renderer;

    try {
      renderer =
        new THREE.WebGLRenderer({
          antialias: true,
          alpha: false,
        });
    } catch {
      try {
        renderer =
          new THREE.WebGLRenderer({
            antialias: false,
            alpha: false,
            powerPreference: 'low-power',
          });
      } catch (error) {
        console.warn(
          'Unable to create the WebGL renderer:',
          error,
        );

        if (webglFallbackRef.current) {
          webglFallbackRef.current.hidden =
            false;
        }

        return undefined;
      }
    }

    renderer.setPixelRatio(
      Math.min(
        window.devicePixelRatio,
        2,
      ),
    );

    renderer.setSize(
      mount.clientWidth,
      mount.clientHeight,
    );

    renderer.outputColorSpace =
      THREE.SRGBColorSpace;

    renderer.toneMapping =
      THREE.ACESFilmicToneMapping;

    renderer.toneMappingExposure =
      1.15;

    mount.appendChild(
      renderer.domElement,
    );

    const controls =
      new OrbitControls(
        camera,
        renderer.domElement,
      );

    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.enablePan = true;
    controls.screenSpacePanning =
      true;
    controls.minDistance = 5;
    controls.maxDistance = 40;

    controls.target.set(
      0,
      1,
      0,
    );

    scene.add(
      new THREE.HemisphereLight(
        0xb8edff,
        0x0b1422,
        1.2,
      ),
    );

    const keyLight =
      new THREE.DirectionalLight(
        0xffffff,
        2.3,
      );

    keyLight.position.set(
      7,
      11,
      8,
    );

    scene.add(keyLight);

    const grid =
      new THREE.GridHelper(
        30,
        30,
        0x193247,
        0x112333,
      );

    grid.position.y = -3.25;

    scene.add(grid);

    const axisMaterial =
      new THREE.LineBasicMaterial({
        color: 0x30516a,
        transparent: true,
        opacity: 0.55,
      });

    const axisGeometry =
      new THREE.BufferGeometry()
        .setFromPoints([
          new THREE.Vector3(
            -13,
            -3.24,
            0,
          ),
          new THREE.Vector3(
            13,
            -3.24,
            0,
          ),
        ]);

    scene.add(
      new THREE.Line(
        axisGeometry,
        axisMaterial,
      ),
    );

    const root =
      new THREE.Group();

    scene.add(root);

    const wireGroup =
      new THREE.Group();

    const fieldGroup =
      new THREE.Group();

    const interactionGroup =
      new THREE.Group();

    const pulseGroup =
      new THREE.Group();

    const poleGroup =
      new THREE.Group();

    root.add(fieldGroup);
    root.add(wireGroup);
    root.add(
      interactionGroup,
    );
    root.add(pulseGroup);
    root.add(poleGroup);

    function createPoleLabel(
      text,
      color,
    ) {
      const canvas =
        document.createElement('canvas');

      canvas.width = 320;
      canvas.height = 96;

      const context =
        canvas.getContext('2d');

      context.font =
        '700 32px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = color;
      context.fillText(
        text,
        canvas.width / 2,
        canvas.height / 2,
      );

      const texture =
        new THREE.CanvasTexture(canvas);

      const label =
        new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
          }),
        );

      label.scale.set(1.35, 0.4, 1);
      label.renderOrder = 7;
      poleGroup.add(label);
      return label;
    }

    const poleMarkers = [
      {
        color: 0xff5c70,
        label: createPoleLabel(
          'north',
          '#ff9aa6',
        ),
      },
      {
        color: 0x4da6ff,
        label: createPoleLabel(
          'south',
          '#8bc9ff',
        ),
      },
    ].map(({ color, label }) => {
      const marker =
        new THREE.Mesh(
          new THREE.SphereGeometry(
            0.52,
            16,
            12,
          ),
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.92,
          }),
        );

      poleGroup.add(marker);
      marker.userData.label = label;
      return marker;
    });

    poleGroup.visible = false;

    const sectionWireGroups =
      Array.from(
        { length: SECTION_COUNT },
        () => new THREE.Group(),
      );

    const sectionInteractionGroups =
      Array.from(
        { length: SECTION_COUNT },
        () => new THREE.Group(),
      );

    const sectionPulseGroups =
      Array.from(
        { length: SECTION_COUNT },
        () => new THREE.Group(),
      );

    sectionWireGroups.forEach(
      (group) => wireGroup.add(group),
    );

    sectionInteractionGroups.forEach(
      (group) =>
        interactionGroup.add(group),
    );

    sectionPulseGroups.forEach(
      (group) => pulseGroup.add(group),
    );

    const raycaster =
      new THREE.Raycaster();

    const pointer =
      new THREE.Vector2();

    let animationFrame = 0;
    let animationStart = 0;
    let animationKind = null;
    let panMotion = null;
    let previousFrameTime = 0;
    let shiftHeld = false;
    let orbitMotion = null;
    const heldArrows = new Set();
    const heldPanButtons = new Set();
    const heldOrbitButtons = new Set();
    let animationFrom = 0;
    let animationTo = 0;
    let animationDuration = WRAP_BASE_MS;
    let tailPullFrom = 0;
    let tailPullTo = 0;

    const hitTargets = [];

    const state = {
      sectionPaths: [],

      tailPull: 0,
      fieldBlend: 1,
      fieldBlendTarget: 1,
    };

    /*
     * Rebuild wire.
     */
    function rebuildWire(
      sectionPaths,
      currentWrappedCount,
      activeSelections,
      changedRange,
    ) {
      const startIndex =
        changedRange
          ? changedRange.start
          : 0;

      const endIndex =
        changedRange
          ? changedRange.end
          : SECTION_COUNT;

      hitTargets.length =
        SECTION_COUNT;

      const firstPath =
        sectionPaths[0];

      const lastPath =
        sectionPaths[SECTION_COUNT - 1];

      const lastWrappedPath =
        sectionPaths[
          Math.max(
            0,
            currentWrappedCount - 1,
          )
        ];

      if (
        firstPath &&
        lastPath &&
        lastWrappedPath
      ) {
        const firstEndpoint =
          firstPath[0];

        const lastEndpoint =
          lastPath[lastPath.length - 1];

        const lastWrappedEndpoint =
          lastWrappedPath[
            lastWrappedPath.length - 1
          ];

        const axisCenter =
          new THREE.Vector3()
            .addVectors(
              firstEndpoint,
              lastEndpoint,
            )
            .multiplyScalar(0.5);

        poleMarkers[1].position.set(
          firstEndpoint.x - 0.55,
          axisCenter.y,
          axisCenter.z + 3.2,
        );
        poleMarkers[0].position.set(
          lastWrappedEndpoint.x + 0.55,
          axisCenter.y,
          axisCenter.z + 3.2,
        );

        poleMarkers[0].userData.label.position
          .copy(poleMarkers[0].position);
        poleMarkers[1].userData.label.position
          .copy(poleMarkers[1].position);
      }

      const selections =
        activeSelections || [];

      for (
        let i = startIndex;
        i < endIndex;
        i++
      ) {
        const groups = [
          sectionWireGroups[i],
          sectionInteractionGroups[i],
          sectionPulseGroups[i],
        ];

        groups.forEach((group) => {
          while (group.children.length) {
            const child =
              group.children[
                group.children.length - 1
              ];

            group.remove(child);
            disposeObject(child);
          }
        });

        const sectionPath =
          sectionPaths[i];

        const isWrapped =
          i < currentWrappedCount;

        const isSelected =
          selections.includes(i);

        const wireMaterial =
          new THREE.MeshStandardMaterial({
            color: isSelected
              ? 0xff76da
              : isWrapped
                ? 0xffa15b
                : 0xe8f5ff,

            emissive:
              new THREE.Color(
                isSelected
                  ? 0x5c154f
                  : isWrapped
                    ? 0x3a1a08
                    : 0x173042,
              ),

            emissiveIntensity:
              isSelected
                ? 0.8
                : 0.35,

            roughness: 0.32,
            metalness: 0.5,
          });

        let mesh;

        /*
         * During animation, partially-curved sections have
         * multiple points too, so render them as curved tubes.
         */
        if (
          sectionPath.length > 2
        ) {
          mesh =
            createCurvedWire(
              sectionPath,
              isSelected
                ? 0.115
                : 0.078,
              wireMaterial,
            );
        } else {
          mesh =
            createCylinderBetween(
              sectionPath[0],
              sectionPath[
                sectionPath.length - 1
              ],
              isSelected
                ? 0.105
                : 0.075,
              wireMaterial,
            );
        }

        mesh.userData.sectionIndex =
          i;

        sectionWireGroups[i].add(mesh);
        hitTargets[i] = mesh;

        /*
         * Selected-section halo.
         */
        if (isSelected) {
          if (
            sectionPath.length > 2
          ) {
            const halo =
              createCurvedWire(
                sectionPath,
                0.16,
                new THREE.MeshBasicMaterial({
                  color: 0xff76da,
                  transparent: true,
                  opacity: 0.18,
                  depthWrite: false,
                }),
              );

            sectionInteractionGroups[i].add(
              halo,
            );
          } else {
            const halo =
              createCylinderBetween(
                sectionPath[0],
                sectionPath[
                  sectionPath.length - 1
                ],
                0.16,
                new THREE.MeshBasicMaterial({
                  color: 0xff76da,
                  transparent: true,
                  opacity: 0.18,
                  depthWrite: false,
                }),
              );

            sectionInteractionGroups[i].add(
              halo,
            );
          }
        }

        /*
         * Current direction arrow.
         */
        const middle =
          sectionPath[
            Math.floor(
              sectionPath.length / 2,
            )
          ];

        const before =
          sectionPath[
            Math.max(
              0,
              Math.floor(
                sectionPath.length / 2,
              ) - 1,
            )
          ];

        const after =
          sectionPath[
            Math.min(
              sectionPath.length - 1,
              Math.floor(
                sectionPath.length / 2,
              ) + 1,
            )
          ];

        const direction =
          new THREE.Vector3()
            .subVectors(
              after,
              before,
            )
            .normalize();

        const arrow =
          new THREE.ArrowHelper(
            direction,
            middle.clone().addScaledVector(
              direction,
              -0.16,
            ),
            isWrapped
              ? 0.42
              : Math.min(
                  0.62,
                  SECTION_LENGTH * 1.1,
                ),
            isSelected
              ? 0xffd9f4
              : 0xffd28f,
            0.20,
            0.11,
          );

        arrow.userData.sectionIndex =
          i;

        sectionInteractionGroups[i].add(
          arrow,
        );

        /*
         * Current pulse marker.
         */
        const marker =
          new THREE.Mesh(
            new THREE.TubeGeometry(
              new THREE.CatmullRomCurve3(
                sectionPath,
                false,
                'centripetal',
              ),
              8,
              0.095,
              8,
              false,
            ),
            new THREE.MeshBasicMaterial({
              color: 0x9f1d35,
              transparent: true,
              depthTest: false,
              depthWrite: false,
              opacity: isSelected ? 1 : 0.65,
            }),
          );

        marker.renderOrder = 6;

        marker.userData.pulsePhase =
          (i / SECTION_COUNT) *
          (COIL_TURNS / PULSE_REPEAT_TURNS) *
          Math.PI *
          2;

        marker.userData.baseOpacity =
          isSelected ? 1 : 0.65;

        sectionPulseGroups[i].add(marker);
      }
    }

    /*
     * Swap one named field group for a freshly built one,
     * recording each material's base opacity for blending.
     */
    function replaceFieldGroup(
      name,
      group,
    ) {
      const old =
        fieldGroup.getObjectByName(name);

      if (old) {
        fieldGroup.remove(old);
        disposeObject(old);
      }

      group.name = name;

      group.traverse((obj) => {
        if (
          obj.material &&
          'opacity' in obj.material
        ) {
          obj.material.userData = {
            ...(obj.material.userData || {}),
            fieldMode: name,
            baseOpacity: obj.material.opacity,
          };
        }
      });

      fieldGroup.add(group);
    }

    /*
     * Rebuild all field visualizations.
     */
    function rebuildFields(
      sectionPaths,
      activeCount,
      activeSelections,
    ) {
      replaceFieldGroup(
        'combinedField',
        buildCombinedField(
          sectionPaths,
          activeCount,
          stateRef.current.combinedLineCount,
          { pitch: coilPitchRef.current },
        ),
      );

      replaceFieldGroup(
        'allContributionsField',
        buildAllContributionsField(
          sectionPaths,
        ),
      );

      replaceFieldGroup(
        'individualField',
        buildSectionField(
          sectionPaths,
          activeSelections,
        ),
      );

      updateFieldBlend();
    }

    /*
     * Per-frame field refresh while sections wrap/unwrap.
     *
     * Only the group for the visible mode is rebuilt, and the
     * combined field uses a coarser current approximation.
     * ('all' mode is already updated per section every frame.)
     */
    function refreshFieldDuringWrap(
      sectionPaths,
      eased,
    ) {
      const { mode, selectedSections } =
        stateRef.current;

      if (mode === 'combined') {
        const low =
          Math.min(animationFrom, animationTo);
        const high =
          Math.max(animationFrom, animationTo);
        const changingWeight =
          animationTo > animationFrom
            ? eased
            : 1 - eased;

        replaceFieldGroup(
          'combinedField',
          buildCombinedField(
            sectionPaths,
            high,
            stateRef.current.combinedLineCount,
            {
              pitch: coilPitchRef.current,
              seedSpan: THREE.MathUtils.lerp(
                animationFrom,
                animationTo,
                eased,
              ),
              stride: ANIMATED_FIELD_STRIDE,
              weightOf: (i) =>
                i < low ? 1 : changingWeight,
            },
          ),
        );
      } else if (
        mode === 'individual' &&
        selectedSections.some(
          (i) => i >= Math.min(animationFrom, animationTo),
        )
      ) {
        replaceFieldGroup(
          'individualField',
          buildSectionField(
            sectionPaths,
            selectedSections,
          ),
        );
      }
    }

    function rebuildContributionSections(
      sectionPaths,
      startIndex,
      endIndex,
    ) {
      if (
        stateRef.current.mode !== 'all'
      ) {
        return;
      }

      const allGroup =
        fieldGroup.getObjectByName(
          'allContributionsField',
        );

      if (!allGroup) {
        return;
      }

      for (
        let sectionIndex = startIndex;
        sectionIndex < endIndex;
        sectionIndex++
      ) {
        const oldSectionGroup =
          allGroup.children.find(
            (child) =>
              child.userData.sectionIndex ===
              sectionIndex,
          );

        if (oldSectionGroup) {
          allGroup.remove(
            oldSectionGroup,
          );

          disposeObject(
            oldSectionGroup,
          );
        }

        const replacementRoot =
          buildAllContributionsField(
            sectionPaths,
            [sectionIndex],
          );

        const replacement =
          replacementRoot.children[0];

        replacementRoot.remove(
          replacement,
        );

        replacement.traverse((obj) => {
          if (
            obj.material &&
            'opacity' in obj.material
          ) {
            obj.material.userData = {
              ...(
                obj.material.userData || {}
              ),
              fieldMode:
                'allContributionsField',
              baseOpacity:
                obj.material.opacity,
            };

            obj.material.opacity *=
              state.fieldBlend;
          }
        });

        allGroup.add(replacement);
      }
    }

    function translateContributionSections(
      startIndex,
      endIndex,
      deltaX,
    ) {
      if (
        stateRef.current.mode !== 'all'
      ) {
        return;
      }

      const allGroup =
        fieldGroup.getObjectByName(
          'allContributionsField',
        );

      if (!allGroup) {
        return;
      }

      allGroup.children.forEach(
        (sectionGroup) => {
          const sectionIndex =
            sectionGroup.userData.sectionIndex;

          if (
            sectionIndex >= startIndex &&
            sectionIndex < endIndex
          ) {
            sectionGroup.position.x +=
              deltaX;
          }
        },
      );
    }

    function updateFieldBlend() {
      const current =
        stateRef.current;

      const combinedGroup =
        fieldGroup.getObjectByName(
          'combinedField',
        );

      const allGroup =
        fieldGroup.getObjectByName(
          'allContributionsField',
        );

      const individualGroup =
        fieldGroup.getObjectByName(
          'individualField',
        );

      if (combinedGroup) {
        combinedGroup.visible =
          current.mode ===
          'combined';

        combinedGroup.traverse(
          (obj) => {
            if (
              obj.material &&
              'opacity' in
                obj.material &&
              obj.material.userData
                .baseOpacity !=
                null
            ) {
              obj.material.opacity =
                obj.material.userData
                  .baseOpacity *
                (current.mode ===
                'combined'
                  ? state.fieldBlend
                  : 0);
            }
          },
        );
      }

      if (allGroup) {
        allGroup.visible =
          current.mode === 'all';

        allGroup.traverse(
          (obj) => {
            if (
              obj.material &&
              'opacity' in
                obj.material &&
              obj.material.userData
                .baseOpacity !=
                null
            ) {
              obj.material.opacity =
                obj.material.userData
                  .baseOpacity *
                (current.mode === 'all'
                  ? state.fieldBlend
                  : 0);
            }
          },
        );
      }

      if (individualGroup) {
        individualGroup.visible =
          current.mode ===
          'individual';

        individualGroup.traverse(
          (obj) => {
            if (
              obj.material &&
              'opacity' in
                obj.material &&
              obj.material.userData
                .baseOpacity !=
                null
            ) {
              obj.material.opacity =
                obj.material.userData
                  .baseOpacity *
                (current.mode ===
                'individual'
                  ? state.fieldBlend
                  : 0);
            }
          },
        );
      }
    }

    function rebuildAll(
      sectionPaths,
    ) {
      const current =
        stateRef.current;

      rebuildWire(
        sectionPaths,
        current.wrappedCount,
        current.selectedSections,
      );

      rebuildFields(
        sectionPaths,
        current.wrappedCount,
        current.selectedSections,
      );

      state.sectionPaths =
        sectionPaths.map(
          (path) =>
            path.map((p) =>
              p.clone(),
            ),
        );
    }

    function beginWrap(
      toCount,
    ) {
      animationKind = 'wrap';

      animationStart =
        performance.now();

      animationFrom =
        stateRef.current
          .wrappedCount;

      animationTo =
        toCount;

      animationDuration =
        wrapDurationMs(
          Math.abs(toCount - animationFrom),
        );

      tailPullFrom =
        state.tailPull;

      tailPullTo =
        toCount *
        SECTION_LENGTH *
        TAIL_PULL_RATIO;

    }

    function handleWrapNext() {
      if (
        stateRef.current
          .wrappedCount >=
          SECTION_COUNT ||
        animationKind
      ) {
        return;
      }

      beginWrap(
        stateRef.current
          .wrappedCount + 1,
      );
    }

    function handleUndo() {
      if (
        stateRef.current
          .wrappedCount <= 0 ||
        animationKind
      ) {
        return;
      }

      beginWrap(
        stateRef.current
          .wrappedCount - 1,
      );
    }

    function handleJumpTo(
      targetCount,
    ) {
      if (animationKind) {
        return;
      }

      const clamped =
        Math.max(
          0,
          Math.min(
            SECTION_COUNT,
            Math.round(
              targetCount,
            ),
          ),
        );

      if (
        clamped ===
        stateRef.current
          .wrappedCount
      ) {
        return;
      }

      beginWrap(clamped);
      setWrappedCount(clamped);
    }

    function handlePitchChange(
      pitch,
    ) {
      if (animationKind) {
        return;
      }

      // React state for the pitch updates on the next render;
      // the field seeding needs the new value now.
      coilPitchRef.current = pitch;

      const paths =
        getAllSectionPaths(
          stateRef.current
            .wrappedCount,
          pitch,
          state.tailPull,
        );

      rebuildAll(paths);
    }

    function handleCombinedLineCountChange(
      count,
    ) {
      const nextCount = Math.max(
        1,
        Math.round(count),
      );

      stateRef.current.combinedLineCount =
        nextCount;

      rebuildFields(
        state.sectionPaths,
        stateRef.current.wrappedCount,
        stateRef.current.selectedSections,
      );
    }

    function handleCombined() {
      if (
        stateRef.current.selectedSections.length
      ) {
        clearSectionSelection();
        return;
      }

      setMode('combined');

      stateRef.current.mode =
        'combined';

      state.fieldBlendTarget = 1;
    }

    function handleAllContributions() {
      setMode('all');
      setSelectedSections([]);

      stateRef.current.mode =
        'all';

      stateRef.current.selectedSections =
        [];

      state.fieldBlendTarget = 1;

      rebuildFields(
        state.sectionPaths,
        stateRef.current
          .wrappedCount,
        [],
      );

      rebuildWire(
        state.sectionPaths,
        stateRef.current
          .wrappedCount,
        [],
      );
    }

    /*
     * Hide every field visualization while keeping
     * the wire and all other controls unchanged.
     */
    function handleNoField() {
      setMode('none');
      setSelectedSections([]);

      stateRef.current.mode =
        'none';

      stateRef.current.selectedSections =
        [];

      state.fieldBlendTarget = 0;

      rebuildFields(
        state.sectionPaths,
        stateRef.current
          .wrappedCount,
        [],
      );

      rebuildWire(
        state.sectionPaths,
        stateRef.current
          .wrappedCount,
        [],
      );
    }

    function handleSelectSection(
      index,
      additive,
    ) {
      if (animationKind) {
        return;
      }

      if (
        index >=
        stateRef.current
          .wrappedCount
      ) {
        return;
      }

      const current =
        stateRef.current
          .selectedSections;

      let next;

      if (!additive) {
        next = [index];
      } else if (
        current.includes(index)
      ) {
        next =
          current.filter(
            (i) =>
              i !== index,
          );
      } else {
        next = [
          ...current,
          index,
        ];
      }

      const nextMode =
        next.length > 0
          ? 'individual'
          : 'combined';

      setSelectedSections(
        next,
      );

      setMode(nextMode);

      stateRef.current.selectedSections =
        next;

      stateRef.current.mode =
        nextMode;

      state.fieldBlendTarget = 1;

      rebuildFields(
        state.sectionPaths,
        stateRef.current
          .wrappedCount,
        next,
      );

      rebuildWire(
        state.sectionPaths,
        stateRef.current
          .wrappedCount,
        next,
      );
    }

    function clearSectionSelection() {
      if (
        !stateRef.current.selectedSections.length
      ) {
        return;
      }

      setSelectedSections([]);
      setMode('combined');

      stateRef.current.selectedSections = [];
      stateRef.current.mode = 'combined';
      state.fieldBlendTarget = 1;

      rebuildFields(
        state.sectionPaths,
        stateRef.current.wrappedCount,
        [],
      );

      rebuildWire(
        state.sectionPaths,
        stateRef.current.wrappedCount,
        [],
      );
    }

    let sectionPointerDown = null;

    function onPointerDown(event) {
      sectionPointerDown = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        shiftKey: event.shiftKey,
      };
    }

    function onPointerUp(event) {
      const pointerDown = sectionPointerDown;
      sectionPointerDown = null;

      if (
        !pointerDown ||
        pointerDown.pointerId !== event.pointerId ||
        Math.hypot(
          event.clientX - pointerDown.clientX,
          event.clientY - pointerDown.clientY,
        ) > 5
      ) {
        return;
      }

      const rect =
        renderer.domElement.getBoundingClientRect();

      pointer.x =
        ((event.clientX -
          rect.left) /
          rect.width) *
          2 -
        1;

      pointer.y =
        -(
          (event.clientY -
            rect.top) /
            rect.height
        ) *
          2 +
        1;

      raycaster.setFromCamera(
        pointer,
        camera,
      );

      const intersections =
        raycaster.intersectObjects(
          hitTargets,
          false,
        );

      if (
        !intersections.length
      ) {
        clearSectionSelection();
        return;
      }

      const index =
        intersections[0].object
          .userData
          .sectionIndex;

      if (
        Number.isInteger(index)
      ) {
        handleSelectSection(
          index,
          pointerDown.shiftKey,
        );
      }
    }

    function onPointerCancel() {
      sectionPointerDown = null;
    }

    function pan(direction) {
      camera.updateMatrixWorld();

      const right =
        new THREE.Vector3()
          .setFromMatrixColumn(
            camera.matrixWorld,
            0,
          )
          .normalize();

      const up =
        new THREE.Vector3()
          .setFromMatrixColumn(
            camera.matrixWorld,
            1,
          )
          .normalize();

      const distance =
        camera.position.distanceTo(
          controls.target,
        );

      const step =
        distance * 0.035;

      let offset;

      if (direction === 'left') {
        offset = right.negate();
      } else if (direction === 'right') {
        offset = right;
      } else if (direction === 'up') {
        offset = up;
      } else if (direction === 'down') {
        offset = up.negate();
      } else {
        return;
      }

      offset.multiplyScalar(step);

      panMotion = {
        startTime: performance.now(),
        startCamera: camera.position.clone(),
        endCamera: camera.position.clone().add(offset),
        startTarget: controls.target.clone(),
        endTarget: controls.target.clone().add(offset),
      };
    }

    function orbit(direction) {
      const spherical =
        new THREE.Spherical().setFromVector3(
          camera.position.clone().sub(
            controls.target,
          ),
        );

      const end = spherical.clone();
      const angle = 0.12;

      if (direction === 'left') {
        end.theta -= angle;
      } else if (direction === 'right') {
        end.theta += angle;
      } else if (direction === 'up') {
        end.phi -= angle;
      } else if (direction === 'down') {
        end.phi += angle;
      } else {
        return;
      }

      end.phi = THREE.MathUtils.clamp(
        end.phi,
        Math.max(0.03, controls.minPolarAngle),
        Math.min(
          Math.PI - 0.03,
          controls.maxPolarAngle,
        ),
      );

      orbitMotion = {
        startTime: performance.now(),
        radius: spherical.radius,
        startTheta: spherical.theta,
        endTheta: end.theta,
        startPhi: spherical.phi,
        endPhi: end.phi,
      };
      panMotion = null;
    }

    function onKeyDown(event) {
      const target = event.target;

      if (
        target instanceof HTMLElement &&
        (
          target.isContentEditable ||
          target.matches(
            'input, textarea, select',
          )
        )
      ) {
        return;
      }

      if (event.key === 'Shift') {
        shiftHeld = true;
      }

      const panDirections = {
        ArrowLeft: 'left',
        ArrowRight: 'right',
        ArrowUp: 'up',
        ArrowDown: 'down',
      };

      if (panDirections[event.key]) {
        event.preventDefault();
        heldArrows.add(event.key);
        shiftHeld = event.shiftKey;
      }

      if (
        event.key === 'Escape' &&
        stateRef.current.selectedSections.length
      ) {
        event.preventDefault();
        clearSectionSelection();
      }
    }

    function onKeyUp(event) {
      if (event.key === 'Shift') {
        shiftHeld = false;
        return;
      }

      heldArrows.delete(event.key);
      shiftHeld = event.shiftKey;
    }

    function stopHeldMotion() {
      heldArrows.clear();
      heldPanButtons.clear();
      heldOrbitButtons.clear();
      shiftHeld = false;
    }

    renderer.domElement.addEventListener(
      'pointerdown',
      onPointerDown,
    );
    renderer.domElement.addEventListener(
      'pointerup',
      onPointerUp,
    );
    renderer.domElement.addEventListener(
      'pointercancel',
      onPointerCancel,
    );
    window.addEventListener(
      'keydown',
      onKeyDown,
    );
    window.addEventListener(
      'keyup',
      onKeyUp,
    );
    window.addEventListener(
      'blur',
      stopHeldMotion,
    );

    function resize() {
      const width =
        mount.clientWidth;

      const height =
        mount.clientHeight;

      camera.aspect =
        width /
        Math.max(height, 1);

      camera.updateProjectionMatrix();

      renderer.setSize(
        width,
        height,
      );
    }

    const resizeObserver =
      new ResizeObserver(
        resize,
      );

    resizeObserver.observe(
      mount,
    );

    rebuildAll(
      getAllSectionPaths(
        0,
        coilPitchRef.current,
      ),
    );

    function animate(now) {
      animationFrame =
        requestAnimationFrame(
          animate,
        );

      const deltaSeconds =
        previousFrameTime
          ? Math.min(
              (now - previousFrameTime) / 1000,
              0.05,
            )
          : 0;

      previousFrameTime = now;

      if (
        deltaSeconds > 0 &&
        (
          heldArrows.size ||
          heldPanButtons.size ||
          heldOrbitButtons.size
        )
      ) {
        orbitMotion = null;
        camera.updateMatrixWorld();

        const right =
          new THREE.Vector3()
            .setFromMatrixColumn(
              camera.matrixWorld,
              0,
            )
            .normalize();

        const up =
          new THREE.Vector3()
            .setFromMatrixColumn(
              camera.matrixWorld,
              1,
            )
            .normalize();

        const panOffset =
          new THREE.Vector3();
        let orbitHorizontal = 0;
        let orbitVertical = 0;

        heldArrows.forEach((key) => {
          const direction =
            key === 'ArrowLeft'
              ? 'left'
              : key === 'ArrowRight'
                ? 'right'
                : key === 'ArrowUp'
                  ? 'up'
                  : 'down';

          if (shiftHeld) {
            if (direction === 'left') {
              orbitHorizontal -= 1;
            } else if (direction === 'right') {
              orbitHorizontal += 1;
            } else if (direction === 'up') {
              orbitVertical -= 1;
            } else {
              orbitVertical += 1;
            }
          } else if (direction === 'left') {
            panOffset.addScaledVector(right, -1);
          } else if (direction === 'right') {
            panOffset.add(right);
          } else if (direction === 'up') {
            panOffset.add(up);
          } else {
            panOffset.addScaledVector(up, -1);
          }
        });

        heldPanButtons.forEach((direction) => {
          if (direction === 'left') {
            panOffset.addScaledVector(right, -1);
          } else if (direction === 'right') {
            panOffset.add(right);
          } else if (direction === 'up') {
            panOffset.add(up);
          } else if (direction === 'down') {
            panOffset.addScaledVector(up, -1);
          }
        });

        heldOrbitButtons.forEach((direction) => {
          if (direction === 'left') {
            orbitHorizontal -= 1;
          } else if (direction === 'right') {
            orbitHorizontal += 1;
          } else if (direction === 'up') {
            orbitVertical -= 1;
          } else if (direction === 'down') {
            orbitVertical += 1;
          }
        });

        if (panOffset.lengthSq() > 0) {
          panOffset.normalize().multiplyScalar(
            camera.position.distanceTo(
              controls.target,
            ) *
              0.35 *
              deltaSeconds,
          );
          camera.position.add(panOffset);
          controls.target.add(panOffset);
          panMotion = null;
        }

        if (orbitHorizontal || orbitVertical) {
          const spherical =
            new THREE.Spherical().setFromVector3(
              camera.position.clone().sub(
                controls.target,
              ),
            );

          spherical.theta +=
            orbitHorizontal * 0.55 * deltaSeconds;
          spherical.phi =
            THREE.MathUtils.clamp(
              spherical.phi +
                orbitVertical * 0.55 * deltaSeconds,
              Math.max(0.03, controls.minPolarAngle),
              Math.min(
                Math.PI - 0.03,
                controls.maxPolarAngle,
              ),
            );

          camera.position
            .copy(controls.target)
            .add(
              new THREE.Vector3()
                .setFromSpherical(spherical),
            );
          panMotion = null;
        }
      }

      if (panMotion) {
        const elapsed =
          Math.min(
            (now - panMotion.startTime) / 220,
            1,
          );

        const eased =
          elapsed *
          elapsed *
          (3 - 2 * elapsed);

        camera.position.lerpVectors(
          panMotion.startCamera,
          panMotion.endCamera,
          eased,
        );

        controls.target.lerpVectors(
          panMotion.startTarget,
          panMotion.endTarget,
          eased,
        );

        if (elapsed >= 1) {
          panMotion = null;
        }
      }

      if (orbitMotion) {
        const elapsed =
          Math.min(
            (now - orbitMotion.startTime) / 220,
            1,
          );

        const eased =
          elapsed *
          elapsed *
          (3 - 2 * elapsed);

        const spherical =
          new THREE.Spherical(
            orbitMotion.radius,
            THREE.MathUtils.lerp(
              orbitMotion.startPhi,
              orbitMotion.endPhi,
              eased,
            ),
            THREE.MathUtils.lerp(
              orbitMotion.startTheta,
              orbitMotion.endTheta,
              eased,
            ),
          );

        camera.position
          .copy(controls.target)
          .add(
            new THREE.Vector3()
              .setFromSpherical(spherical),
          );

        if (elapsed >= 1) {
          orbitMotion = null;
        }
      }

      if (animationKind === 'wrap') {
        const elapsed =
          Math.min(
            (now -
              animationStart) /
              animationDuration,
            1,
          );

        const eased =
          elapsed *
          elapsed *
          (3 - 2 * elapsed);

        const previousTailPull =
          state.tailPull;

        state.tailPull =
          THREE.MathUtils.lerp(
            tailPullFrom,
            tailPullTo,
            eased,
          );

        const paths =
          getAnimatedSectionPaths(
            animationFrom,
            animationTo,
            eased,
            coilPitchRef.current,
            animationTo > animationFrom
              ? state.sectionPaths
              : undefined,
            state.tailPull,
          );

        const fieldCount =
          Math.min(
            SECTION_COUNT,
            Math.max(
              animationFrom,
              animationTo,
            ),
          );

        rebuildWire(
          paths,
          fieldCount,
          stateRef.current
            .selectedSections,
          {
            start: Math.min(
              animationFrom,
              animationTo,
            ),
            end: SECTION_COUNT,
          },
        );

        translateContributionSections(
          Math.max(
            animationFrom,
            animationTo,
          ),
          SECTION_COUNT,
          previousTailPull -
            state.tailPull,
        );

        rebuildContributionSections(
          paths,
          Math.min(
            animationFrom,
            animationTo,
          ),
          Math.max(
            animationFrom,
            animationTo,
          ),
        );

        state.sectionPaths = paths;

        if (elapsed < 1) {
          refreshFieldDuringWrap(
            paths,
            eased,
          );
        }

        if (elapsed >= 1) {
          setWrappedCount(
            animationTo,
          );

          stateRef.current.wrappedCount =
            animationTo;

          const stillValid =
            stateRef.current
              .selectedSections.filter(
                (idx) =>
                  idx <
                  animationTo,
              );

          if (
            stillValid.length !==
            stateRef.current
              .selectedSections
              .length
          ) {
            setSelectedSections(
              stillValid,
            );

            stateRef.current.selectedSections =
              stillValid;

            if (
              stillValid.length ===
              0
            ) {
              setMode('combined');

              stateRef.current.mode =
                'combined';
            }
          }

          const finalPaths =
            getAllSectionPaths(
              animationTo,
              coilPitchRef.current,
              state.tailPull,
            );

          rebuildAll(
            finalPaths,
          );

          animationKind = null;
        }
      }

      /*
       * Smooth mode transition.
       */
      state.fieldBlend +=
        (state.fieldBlendTarget -
          state.fieldBlend) *
        0.14;

      updateFieldBlend();

      pulseGroup.traverse(
        (marker) => {
          if (!marker.isMesh) {
            return;
          }

          const pulsePosition =
            (
              now * 0.0022 -
              marker.userData.pulsePhase
            ) %
            (Math.PI * 2);

          const pulseWidth =
            0.9;

          const pulseStrength =
            pulsePosition < 0 ||
            pulsePosition >= pulseWidth
              ? 0
              : 1 -
                pulsePosition /
                  pulseWidth;

          if (marker.material) {
            marker.material.opacity =
              marker.userData.baseOpacity *
              pulseStrength;
          }
        },
      );

      controls.update();

      renderer.render(
        scene,
        camera,
      );
    }

    animationFrame =
      requestAnimationFrame(
        animate,
      );

    mount._magneticTool = {
      showCurrent:
        (visible) => {
          pulseGroup.visible = visible;
        },

      showPoles:
        (visible) => {
          poleGroup.visible = visible;
        },

      wrapNext:
        handleWrapNext,

      undo:
        handleUndo,

      combined:
        handleCombined,

      allContributions:
        handleAllContributions,

      noField:
        handleNoField,

      jumpTo:
        handleJumpTo,

      pan,

      holdPan:
        (direction, held) => {
          if (held) {
            heldPanButtons.add(direction);
            panMotion = null;
          } else {
            heldPanButtons.delete(direction);
          }
        },

      orbit,

      holdOrbit:
        (direction, held) => {
          if (held) {
            heldOrbitButtons.add(direction);
            orbitMotion = null;
            panMotion = null;
          } else {
            heldOrbitButtons.delete(direction);
          }
        },

      pitchChange:
        handlePitchChange,

      combinedLineCountChange:
        handleCombinedLineCountChange,
    };

    return () => {
      cancelAnimationFrame(
        animationFrame,
      );

      resizeObserver.disconnect();

      renderer.domElement.removeEventListener(
        'pointerdown',
        onPointerDown,
      );
      renderer.domElement.removeEventListener(
        'pointerup',
        onPointerUp,
      );
      renderer.domElement.removeEventListener(
        'pointercancel',
        onPointerCancel,
      );
      window.removeEventListener(
        'keydown',
        onKeyDown,
      );
      window.removeEventListener(
        'keyup',
        onKeyUp,
      );
      window.removeEventListener(
        'blur',
        stopHeldMotion,
      );

      controls.dispose();

      disposeObject(scene);

      renderer.dispose();
      renderer.forceContextLoss();

      renderer.domElement.remove();

      delete mount._magneticTool;
    };
  }, []);

  const canWrap =
    wrappedCount <
    SECTION_COUNT;

  const canUndo =
    wrappedCount > 0;

  const triggerWrap = () =>
    mountRef.current?._magneticTool?.wrapNext();

  const triggerUndo = () =>
    mountRef.current?._magneticTool?.undo();

  const triggerPan = (direction) =>
    mountRef.current?._magneticTool?.pan(direction);

  const triggerPanHold = (direction, held) =>
    mountRef.current?._magneticTool?.holdPan(
      direction,
      held,
    );

  const triggerOrbit = (direction) =>
    mountRef.current?._magneticTool?.orbit(
      direction,
    );

  const triggerOrbitHold = (direction, held) =>
    mountRef.current?._magneticTool?.holdOrbit(
      direction,
      held,
    );

  const handleCurrentToggle =
    (event) => {
      const visible =
        event.target.checked;

      setShowCurrent(visible);

      mountRef.current?._magneticTool
        ?.showCurrent(visible);
    };

  const handlePolesToggle =
    (event) => {
      const visible =
        event.target.checked;

      setShowPoles(visible);

      mountRef.current?._magneticTool
        ?.showPoles(visible);
    };

  const triggerCombined = () =>
    mountRef.current?._magneticTool?.combined();

  const triggerAllContributions = () =>
    mountRef.current?._magneticTool?.allContributions();

  const triggerNoField = () =>
    mountRef.current?._magneticTool?.noField();

  const handlePitchSliderChange =
    (event) => {
      const value =
        Number(event.target.value);

      setCoilPitch(value);

      mountRef.current?._magneticTool
        ?.pitchChange(value);
    };

  const handleCombinedLineCountChange =
    (event) => {
      const value =
        Number(event.target.value);

      setCombinedLineCount(value);

      mountRef.current?._magneticTool
        ?.combinedLineCountChange(value);
    };

  const jumpToFractionOfBar = (
    clientX,
    element,
  ) => {
    const rect =
      element.getBoundingClientRect();

    const fraction =
      rect.width > 0
        ? (clientX -
            rect.left) /
          rect.width
        : 0;

    const clampedFraction =
      Math.max(
        0,
        Math.min(
          1,
          fraction,
        ),
      );

    const target =
      Math.round(
        clampedFraction *
          SECTION_COUNT,
      );

    mountRef.current?._magneticTool?.jumpTo(
      target,
    );
  };

  const handleProgressBarClick =
    (event) => {
      jumpToFractionOfBar(
        event.clientX,
        event.currentTarget,
      );
    };

  const handleProgressBarDrag =
    (event) => {
      if (event.buttons !== 1) {
        return;
      }

      jumpToFractionOfBar(
        event.clientX,
        event.currentTarget,
      );
    };

  return (
    <div className="magnetic-app">
      <style>{`
        * {
          box-sizing: border-box;
        }

        .magnetic-app {
          width: 100%;
          min-height: 100svh;
          margin: 0;
          padding: 16px;
          display: grid;
          place-items: center;
          background:
            radial-gradient(
              circle at 18% 8%,
              rgba(38, 121, 158, 0.18),
              transparent 32%
            ),
            radial-gradient(
              circle at 82% 92%,
              rgba(114, 55, 122, 0.12),
              transparent 34%
            ),
            #030910;
          color: #edf9ff;
          font-family:
            Inter,
            ui-sans-serif,
            system-ui,
            -apple-system,
            BlinkMacSystemFont,
            "Segoe UI",
            sans-serif;
        }

        .magnetic-panel {
          position: relative;
          width: min(1600px, 100%);
          height: min(
            960px,
            calc(100svh - 32px)
          );
          min-height: min(
            640px,
            calc(100svh - 32px)
          );
          overflow: hidden;
          border: 1px solid
            rgba(145, 211, 239, 0.15);
          border-radius: 22px;
          background: #07111b;
          box-shadow:
            0 30px 90px
              rgba(0, 0, 0, 0.42),
            inset 0 1px 0
              rgba(255, 255, 255, 0.05);
        }

        .three-stage {
          position: absolute;
          inset: 0;
        }

        .three-stage canvas {
          display: block;
          width: 100%;
          height: 100%;
          cursor: grab;
        }

        .three-stage canvas:active {
          cursor: grabbing;
        }

        .hud {
          position: absolute;
          z-index: 4;
          pointer-events: none;
        }

        /*
         * Title, controls and help share one grid, so they can never
         * overlap: wide screens put the controls in a right-hand column,
         * narrow screens stack everything in one column.
         */
        .top-bar {
          top: 20px;
          left: 22px;
          right: 20px;
          display: grid;
          grid-template-columns: minmax(300px, 1fr) auto;
          grid-template-areas:
            "title controls"
            "help  controls";
          grid-template-rows: auto 1fr;
          column-gap: 24px;
          row-gap: 12px;
          align-items: start;
        }

        .top-title {
          grid-area: title;
          min-width: 0;
        }

        .kicker {
          margin-bottom: 6px;
          font-size: 11px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: #7fc5e5;
          font-weight: 750;
        }

        .title {
          margin: 0;
          font-size: clamp(
            24px,
            3vw,
            34px
          );
          line-height: 1.05;
          letter-spacing: -0.035em;
        }

        .top-controls {
          grid-area: controls;
          justify-self: end;
          min-width: 0;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 8px;
          pointer-events: auto;
        }

        /* groups wrap as whole units, never splitting a pair */
        .toolbar {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          align-items: center;
          gap: 8px 14px;
        }

        .toolbar-group {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .segmented {
          display: inline-flex;
          align-items: center;
          gap: 2px;
          padding: 2px;
          border: 1px solid rgba(147, 212, 240, 0.18);
          border-radius: 12px;
          background: rgba(8, 20, 30, 0.78);
          backdrop-filter: blur(10px);
        }

        .segment {
          padding: 7px 10px;
          border: 1px solid transparent;
          border-radius: 9px;
          background: transparent;
          color: #a9c6d3;
          font: inherit;
          font-size: 12px;
          font-weight: 700;
          white-space: nowrap;
          cursor: pointer;
          transition:
            background .15s ease,
            border-color .15s ease,
            color .15s ease;
        }

        .segment:hover:not(.active) {
          background: rgba(11, 32, 45, 0.9);
          color: #eaf8ff;
        }

        .segment:focus-visible {
          outline: 2px solid rgba(98, 230, 255, 0.6);
          outline-offset: 1px;
        }

        .segment.active {
          border-color: #62e6ff;
          background: rgba(23, 83, 105, 0.95);
          color: #eaf8ff;
          box-shadow: 0 0 14px rgba(98, 230, 255, 0.18);
        }

        .segment.multicolor.active {
          border-color: rgba(92, 224, 207, 0.85);
          background: rgba(16, 78, 76, 0.95);
          box-shadow: 0 0 14px rgba(92, 224, 207, 0.2);
        }

        .current-toggle {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 9px 12px;
          border: 1px solid rgba(255, 106, 91, 0.42);
          border-radius: 12px;
          background: rgba(46, 15, 18, 0.82);
          color: #ffd5cf;
          font-size: 12px;
          font-weight: 800;
          white-space: nowrap;
          cursor: pointer;
        }

        .current-toggle input {
          accent-color: #d8333e;
          width: 15px;
          height: 15px;
          margin: 0;
        }

        .slider-panel {
          display: grid;
          grid-template-columns: repeat(2, 200px);
          gap: 18px;
          padding: 11px 14px 12px;
          border-radius: 13px;
          background: rgba(5, 14, 22, 0.78);
          border: 1px solid rgba(160, 218, 240, 0.15);
          backdrop-filter: blur(10px);
        }

        .slider-field {
          display: flex;
          flex-direction: column;
          gap: 7px;
          min-width: 0;
          cursor: pointer;
          transition: opacity .15s ease;
        }

        .slider-field.is-disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .slider-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }

        .slider-label {
          color: #c9dbe3;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          white-space: nowrap;
        }

        .slider-value {
          min-width: 44px;
          padding: 2px 7px;
          border-radius: 6px;
          background: rgba(71, 200, 255, 0.1);
          border: 1px solid rgba(98, 230, 255, 0.18);
          color: #9eeeff;
          font-size: 11px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          text-align: center;
        }

        /*
         * Range input: the track shows the progress-bar gradient up to
         * the thumb's centre (--fill is 0..1, the thumb is 16px wide).
         */
        .slider-input {
          --thumb: 16px;
          --track: 6px;
          --filled: calc(
            var(--thumb) / 2 +
              (100% - var(--thumb)) * var(--fill, 0)
          );
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 18px;
          margin: 0;
          background: transparent;
          cursor: inherit;
        }

        .slider-input:focus {
          outline: none;
        }

        .slider-input::-webkit-slider-runnable-track {
          height: var(--track);
          border-radius: 999px;
          border: 1px solid rgba(127, 197, 229, 0.16);
          background:
            linear-gradient(90deg, #47c8ff, #8a8dff)
              0 0 / var(--filled) 100% no-repeat,
            rgba(127, 197, 229, 0.09);
        }

        .slider-input::-moz-range-track {
          height: var(--track);
          border-radius: 999px;
          border: 1px solid rgba(127, 197, 229, 0.16);
          background:
            linear-gradient(90deg, #47c8ff, #8a8dff)
              0 0 / var(--filled) 100% no-repeat,
            rgba(127, 197, 229, 0.09);
        }

        .slider-input::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: var(--thumb);
          height: var(--thumb);
          margin-top: calc(
            (var(--track) - var(--thumb)) / 2 - 1px
          );
          border-radius: 50%;
          border: 2px solid #62e6ff;
          background: #eaf8ff;
          box-shadow: 0 0 12px rgba(98, 230, 255, 0.45);
          transition:
            transform .15s ease,
            box-shadow .15s ease;
        }

        .slider-input::-moz-range-thumb {
          width: var(--thumb);
          height: var(--thumb);
          box-sizing: border-box;
          border-radius: 50%;
          border: 2px solid #62e6ff;
          background: #eaf8ff;
          box-shadow: 0 0 12px rgba(98, 230, 255, 0.45);
          transition:
            transform .15s ease,
            box-shadow .15s ease;
        }

        .slider-field:not(.is-disabled):hover
          .slider-input::-webkit-slider-thumb,
        .slider-input:active::-webkit-slider-thumb {
          transform: scale(1.12);
          box-shadow: 0 0 16px rgba(98, 230, 255, 0.7);
        }

        .slider-field:not(.is-disabled):hover
          .slider-input::-moz-range-thumb,
        .slider-input:active::-moz-range-thumb {
          transform: scale(1.12);
          box-shadow: 0 0 16px rgba(98, 230, 255, 0.7);
        }

        .slider-input:focus-visible::-webkit-slider-thumb {
          box-shadow:
            0 0 0 4px rgba(98, 230, 255, 0.28),
            0 0 16px rgba(98, 230, 255, 0.7);
        }

        .slider-input:focus-visible::-moz-range-thumb {
          box-shadow:
            0 0 0 4px rgba(98, 230, 255, 0.28),
            0 0 16px rgba(98, 230, 255, 0.7);
        }

        .slider-input:disabled::-webkit-slider-thumb {
          border-color: #7f9dad;
          box-shadow: none;
        }

        .slider-input:disabled::-moz-range-thumb {
          border-color: #7f9dad;
          box-shadow: none;
        }

        .control {
          border: 1px solid
            rgba(147, 212, 240, 0.18);
          background:
            rgba(8, 20, 30, 0.78);
          backdrop-filter: blur(10px);
          color: #eaf8ff;
          border-radius: 12px;
          padding: 9px 12px;
          font-weight: 700;
          font-size: 12px;
          white-space: nowrap;
          cursor: pointer;
          transition:
            transform .15s ease,
            border-color .15s ease,
            background .15s ease,
            opacity .15s ease;
        }

        .control:hover:not(:disabled) {
          transform:
            translateY(-1px);
          border-color:
            rgba(
              127,
              197,
              229,
              0.44
            );
          background:
            rgba(
              11,
              32,
              45,
              0.9
            );
        }

        .control.active {
          border-color: #62e6ff;
          background:
            rgba(
              23,
              83,
              105,
              0.95
            );
          box-shadow:
            0 0 0 2px
              rgba(
                98,
                230,
                255,
                0.18
              ),
            0 0 18px
              rgba(
                98,
                230,
                255,
                0.18
              );
        }

        .control:disabled {
          opacity: 0.34;
          cursor: default;
        }

        .control.primary {
          background:
            linear-gradient(
              180deg,
              rgba(
                24,
                90,
                119,
                0.95
              ),
              rgba(
                15,
                58,
                78,
                0.95
              )
            );
          border-color:
            rgba(
              102,
              214,
              255,
              0.34
            );
        }

        .mode-pill {
          position: absolute;
          left: 22px;
          bottom: 20px;
          z-index: 4;
          pointer-events: none;
          padding: 10px 12px;
          border-radius: 12px;
          background:
            rgba(
              5,
              14,
              22,
              0.78
            );
          border: 1px solid
            rgba(
              160,
              218,
              240,
              0.15
            );
          backdrop-filter: blur(10px);
          font-size: 12px;
          color: #b7cfdb;
        }

        .field-legend {
          position: absolute;
          right: 20px;
          bottom: 20px;
          z-index: 4;
          min-width: 245px;
          padding: 12px 13px;
          border-radius: 13px;
          background:
            rgba(
              5,
              14,
              22,
              0.78
            );
          border: 1px solid
            rgba(
              160,
              218,
              240,
              0.15
            );
          backdrop-filter: blur(10px);
          pointer-events: none;
        }

        .legend-title {
          font-size: 12px;
          font-weight: 800;
          color: #f5fbff;
          margin-bottom: 7px;
        }

        .legend-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          color: #a4bfcc;
          line-height: 1.35;
        }

        .legend-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex: 0 0 auto;
          box-shadow:
            0 0 14px currentColor;
        }

        .legend-dot.cyan {
          color: #4de4ff;
          background: #4de4ff;
        }

        .legend-dot.pink {
          color: #ff76da;
          background: #ff76da;
        }

        .legend-dot.rainbow {
          background:
            linear-gradient(
              90deg,
              #ff5f8f,
              #ffc857,
              #55d6a4,
              #55a8ff,
              #ee72ff
            );
          box-shadow:
            0 0 14px
              rgba(
                130,
                220,
                255,
                0.65
              );
        }

        .progress-wrap {
          position: absolute;
          left: 22px;
          right: 22px;
          bottom: 92px;
          z-index: 4;
          pointer-events: none;
        }

        .progress-meta {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 7px;
          font-size: 11px;
          color: #7f9dad;
        }

        .progress-hit {
          padding: 9px 0;
          pointer-events: auto;
          cursor: pointer;
          touch-action: none;
        }

        .progress-bar {
          position: relative;
          height: 7px;
          border-radius: 999px;
          background:
            rgba(
              127,
              197,
              229,
              0.09
            );
          overflow: hidden;
          border: 1px solid
            rgba(
              127,
              197,
              229,
              0.09
            );
          transition:
            border-color .15s ease;
        }

        .progress-hit:hover .progress-bar {
          border-color:
            rgba(
              127,
              197,
              229,
              0.32
            );
        }

        .progress-fill {
          height: 100%;
          border-radius: inherit;
          background:
            linear-gradient(
              90deg,
              #47c8ff,
              #8a8dff
            );
          box-shadow:
            0 0 16px
              rgba(
                71,
                200,
                255,
                0.28
              );
          transition:
            width .28s ease;
        }

        .progress-hit:active .progress-fill {
          transition: none;
        }

        .help {
          grid-area: help;
          justify-self: start;
          max-width: 560px;
          padding: 9px 11px;
          border-radius: 10px;
          background:
            rgba(
              5,
              14,
              22,
              0.78
            );
          border: 1px solid
            rgba(
              160,
              218,
              240,
              0.12
            );
          backdrop-filter: blur(10px);
          color: #8fb1c1;
          font-size: 11px;
          line-height: 1.4;
        }

        .direction-controls {
          position: absolute;
          right: 22px;
          bottom: 150px;
          z-index: 5;
          display: flex;
          align-items: flex-end;
          gap: 14px;
          pointer-events: auto;
        }

        .direction-group {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
        }

        .direction-label {
          color: #c9cdcf;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.08em;
          line-height: 1;
          text-transform: uppercase;
        }

        .direction-pad {
          display: grid;
          grid-template-columns: repeat(3, 40px);
          grid-template-rows: repeat(4, 40px);
          gap: 4px;
        }

        .pan-button {
          display: grid;
          place-items: center;
          width: 40px;
          height: 40px;
          padding: 0;
          border: 1px solid rgba(147, 212, 240, 0.24);
          border-radius: 9px;
          background: rgba(8, 20, 30, 0.82);
          backdrop-filter: blur(10px);
          color: #eaf8ff;
          font-size: 20px;
          line-height: 1;
          cursor: pointer;
          touch-action: manipulation;
          transition:
            background .15s ease,
            border-color .15s ease,
            transform .15s ease;
        }

        .pan-button:hover {
          transform: translateY(-1px);
          border-color: rgba(127, 197, 229, 0.62);
          background: rgba(23, 83, 105, 0.95);
        }

        .orbit-button {
          border-color: rgba(255, 181, 92, 0.34);
          background: rgba(40, 28, 17, 0.88);
          color: #ffe0b3;
        }

        .orbit-button:hover {
          border-color: rgba(255, 197, 116, 0.78);
          background: rgba(91, 57, 22, 0.96);
        }

        .pan-button:focus-visible {
          outline: 2px solid #62e6ff;
          outline-offset: 2px;
        }

        .orbit-horizontal-button {
          height: 28px;
          align-self: center;
        }

        .orbit-vertical-button {
          height: 25.2px;
        }

        .direction-arrow {
          display: inline-block;
          width: 22px;
          height: 22px;
          overflow: visible;
        }

        .direction-arrow-shadow,
        .direction-arrow-face,
        .direction-arrow-highlight {
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
        }

        .direction-arrow-shadow {
          stroke: rgba(58, 36, 16, 0.72);
          stroke-width: 3.8;
          transform: translateY(1px);
        }

        .direction-arrow-face {
          stroke: currentColor;
          stroke-width: 2.8;
        }

        .direction-arrow-highlight {
          stroke: rgba(255, 255, 255, 0.42);
          stroke-width: 0.9;
          transform: translateY(-0.45px);
        }

        .orbit-curve-arrow {
          display: inline-block;
          width: 22px;
          height: 22px;
          overflow: visible;
        }

        .orbit-arrow-shadow,
        .orbit-arrow-face,
        .orbit-arrow-highlight {
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
        }

        .orbit-arrow-shadow {
          stroke: rgba(58, 36, 16, 0.9);
          stroke-width: 3.8;
          transform: translateY(1px);
        }

        .orbit-arrow-face {
          stroke: #d9b779;
          stroke-width: 2.8;
        }

        .orbit-arrow-highlight {
          stroke: rgba(255, 236, 194, 0.82);
          stroke-width: 0.9;
          transform: translateY(-0.45px);
        }

        .direction-group:first-child .orbit-horizontal-left {
          grid-area: 2 / 1;
        }

        .direction-group:first-child .orbit-horizontal-right {
          grid-area: 2 / 3;
        }

        .pan-up {
          grid-area: 2 / 2;
        }

        .orbit-vertical-up {
          grid-area: 1 / 2;
          align-self: end;
        }

        .orbit-vertical-down {
          grid-area: 4 / 2;
          align-self: start;
        }

        .pan-left {
          grid-area: 3 / 1;
        }

        .pan-right {
          grid-area: 3 / 3;
        }

        .pan-down {
          grid-area: 3 / 2;
        }

        .webgl-fallback {
          position: absolute;
          inset: 0;
          z-index: 5;
          display: grid;
          place-content: center;
          gap: 8px;
          padding: 24px;
          background: rgba(3, 9, 16, 0.94);
          color: #edf9ff;
          text-align: center;
        }

        .webgl-fallback[hidden] {
          display: none;
        }

        .webgl-fallback strong {
          font-size: 18px;
        }

        .webgl-fallback span {
          max-width: 420px;
          color: #a8c5d3;
          font-size: 14px;
        }

        @media (max-width: 1000px) {
          .control {
            padding: 8px 9px;
          }
        }

        @media (max-width: 820px) {
          .magnetic-app {
            padding: 0;
          }

          .magnetic-panel {
            height: 100vh;
            min-height: 0;
            border-radius: 0;
            border: 0;
          }

          .top-bar {
            top: 16px;
            left: 18px;
            right: 18px;
            grid-template-columns: minmax(0, 1fr);
            grid-template-areas:
              "title"
              "controls"
              "help";
            grid-template-rows: auto;
            row-gap: 10px;
          }

          .top-controls {
            justify-self: stretch;
            align-items: flex-start;
          }

          .toolbar {
            justify-content: flex-start;
            gap: 6px 10px;
          }

          .slider-panel {
            width: min(460px, 100%);
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .help {
            max-width: 560px;
          }
        }

        @media (max-width: 620px) {
          .field-legend {
            display: none;
          }

          .direction-controls {
            right: 16px;
            bottom: 142px;
            gap: 10px;
          }

          .direction-pad {
            grid-template-columns: repeat(3, 36px);
            grid-template-rows: repeat(4, 36px);
          }

          .pan-button {
            width: 36px;
            height: 36px;
          }

          .orbit-horizontal-button {
            height: 25px;
          }

          .orbit-vertical-button {
            height: 22.5px;
          }

          .progress-wrap {
            bottom: 85px;
          }
        }

        @media (max-width: 440px) {
          .toolbar-group {
            gap: 5px;
          }

          .control,
          .current-toggle {
            padding: 7px 8px;
            font-size: 11px;
          }

          .segment {
            padding: 6px 8px;
            font-size: 11px;
          }

          .current-toggle {
            gap: 5px;
          }

          .help {
            font-size: 10.5px;
          }

          .slider-panel {
            gap: 14px;
            padding: 10px 12px 11px;
          }
        }
      `}</style>

      <div className="magnetic-panel">
        <div
          ref={webglFallbackRef}
          className="webgl-fallback"
          hidden
          role="alert"
        >
          <strong>3D view unavailable</strong>
          <span>
            This browser could not create a WebGL context. Try enabling hardware acceleration or using another browser or device.
          </span>
        </div>

        <div
          ref={mountRef}
          className="three-stage"
        />

        <div className="hud top-bar">
          <div className="top-title">
            <div className="kicker">
              Magnetism · 3D exploration
            </div>

            <h1 className="title">
              From straight wire to
              solenoid
            </h1>
          </div>

          <div className="top-controls">
            <div className="toolbar">
              <div
                className="toolbar-group"
                role="group"
                aria-label="Build the coil"
              >
                <button
                  className="control"
                  onClick={triggerUndo}
                  disabled={!canUndo}
                >
                  Unwrap
                </button>

                <button
                  className="control primary"
                  onClick={triggerWrap}
                  disabled={!canWrap}
                >
                  Wrap
                </button>
              </div>

              <div
                className="toolbar-group"
                role="group"
                aria-label="Overlays"
              >
                <label className="current-toggle">
                  <input
                    type="checkbox"
                    checked={showCurrent}
                    onChange={handleCurrentToggle}
                  />
                  <span>Show current</span>
                </label>

                <label className="current-toggle">
                  <input
                    type="checkbox"
                    checked={showPoles}
                    onChange={handlePolesToggle}
                  />
                  <span>Show poles</span>
                </label>
              </div>

              <div
                className="segmented"
                role="group"
                aria-label="Field view"
              >
                <button
                  className={`segment ${
                    mode === 'none' ? 'active' : ''
                  }`}
                  aria-pressed={mode === 'none'}
                  onClick={triggerNoField}
                >
                  No field
                </button>

                <button
                  className={`segment ${
                    mode === 'combined' ? 'active' : ''
                  }`}
                  aria-pressed={mode === 'combined'}
                  onClick={triggerCombined}
                >
                  Combined field
                </button>

                <button
                  className={`segment multicolor ${
                    mode === 'all' ? 'active' : ''
                  }`}
                  aria-pressed={mode === 'all'}
                  onClick={triggerAllContributions}
                >
                  Contributions
                </button>
              </div>
            </div>

            <div className="slider-panel">
              <SliderField
                label="Coil pitch"
                valueText={coilPitch.toFixed(3)}
                value={coilPitch}
                min={0.03}
                max={0.3}
                step={0.005}
                onChange={handlePitchSliderChange}
              />

              <SliderField
                label="Field lines"
                valueText={combinedLineCount}
                value={combinedLineCount}
                min={4}
                max={36}
                step={2}
                onChange={
                  handleCombinedLineCountChange
                }
                disabled={mode !== 'combined'}
                disabledHint="Only used in the Combined field view"
              />
            </div>
          </div>

          <div className="help">
            Drag = orbit · Wheel = zoom ·
            Right-drag / hold arrows = pan ·
            Shift+arrows = orbit · Click a
            wrapped section = isolate its
            field · Shift+click sections to
            compare their fields ·
            Click the progress bar
            to jump to a section count
          </div>
        </div>

        <div className="direction-controls">
          <div className="direction-group">
              <span className="direction-label">Pan / Orbit</span>
            <div
              className="direction-pad"
              role="group"
              aria-label="Pan and orbit controls"
            >
              <button
                type="button"
                className="pan-button orbit-button orbit-vertical-button orbit-vertical-up"
                aria-label="Orbit up"
                title="Orbit up"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  triggerOrbitHold('up', true);
                }}
                onPointerUp={(event) => {
                  triggerOrbitHold('up', false);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => triggerOrbitHold('up', false)}
                onLostPointerCapture={() => triggerOrbitHold('up', false)}
                onClick={(event) => {
                  if (event.detail === 0) triggerOrbit('up');
                }}
              ><DirectionArrow direction="up" /></button>
              <button
                type="button"
                className="pan-button orbit-button orbit-horizontal-button orbit-horizontal-left"
                aria-label="Orbit left"
                title="Orbit left"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  triggerOrbitHold('left', true);
                }}
                onPointerUp={(event) => {
                  triggerOrbitHold('left', false);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => triggerOrbitHold('left', false)}
                onLostPointerCapture={() => triggerOrbitHold('left', false)}
                onClick={(event) => {
                  if (event.detail === 0) triggerOrbit('left');
                }}
              >
                <svg
                  className="orbit-curve-arrow"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    className="orbit-arrow-shadow"
                    d="M20 19 C12 19 8 14 8 8 M4 8 L8 4 L12 8"
                  />
                  <path
                    className="orbit-arrow-face"
                    d="M20 19 C12 19 8 14 8 8 M4 8 L8 4 L12 8"
                  />
                  <path
                    className="orbit-arrow-highlight"
                    d="M20 19 C12 19 8 14 8 8 M4 8 L8 4 L12 8"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="pan-button pan-up"
                aria-label="Pan up"
                title="Pan up"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  triggerPanHold('up', true);
                }}
                onPointerUp={(event) => {
                  triggerPanHold('up', false);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => triggerPanHold('up', false)}
                onLostPointerCapture={() => triggerPanHold('up', false)}
                onClick={(event) => {
                  if (event.detail === 0) triggerPan('up');
                }}
              ><DirectionArrow direction="up" /></button>
              <button
                type="button"
                className="pan-button orbit-button orbit-horizontal-button orbit-horizontal-right"
                aria-label="Orbit right"
                title="Orbit right"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  triggerOrbitHold('right', true);
                }}
                onPointerUp={(event) => {
                  triggerOrbitHold('right', false);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => triggerOrbitHold('right', false)}
                onLostPointerCapture={() => triggerOrbitHold('right', false)}
                onClick={(event) => {
                  if (event.detail === 0) triggerOrbit('right');
                }}
              >
                <svg
                  className="orbit-curve-arrow"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    className="orbit-arrow-shadow"
                    d="M4 19 C12 19 16 14 16 8 M12 8 L16 4 L20 8"
                  />
                  <path
                    className="orbit-arrow-face"
                    d="M4 19 C12 19 16 14 16 8 M12 8 L16 4 L20 8"
                  />
                  <path
                    className="orbit-arrow-highlight"
                    d="M4 19 C12 19 16 14 16 8 M12 8 L16 4 L20 8"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="pan-button pan-left"
                aria-label="Pan left"
                title="Pan left"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  triggerPanHold('left', true);
                }}
                onPointerUp={(event) => {
                  triggerPanHold('left', false);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => triggerPanHold('left', false)}
                onLostPointerCapture={() => triggerPanHold('left', false)}
                onClick={(event) => {
                  if (event.detail === 0) triggerPan('left');
                }}
              ><DirectionArrow direction="left" /></button>
              <button
                type="button"
                className="pan-button pan-right"
                aria-label="Pan right"
                title="Pan right"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  triggerPanHold('right', true);
                }}
                onPointerUp={(event) => {
                  triggerPanHold('right', false);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => triggerPanHold('right', false)}
                onLostPointerCapture={() => triggerPanHold('right', false)}
                onClick={(event) => {
                  if (event.detail === 0) triggerPan('right');
                }}
              ><DirectionArrow direction="right" /></button>
              <button
                type="button"
                className="pan-button pan-down"
                aria-label="Pan down"
                title="Pan down"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  triggerPanHold('down', true);
                }}
                onPointerUp={(event) => {
                  triggerPanHold('down', false);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => triggerPanHold('down', false)}
                onLostPointerCapture={() => triggerPanHold('down', false)}
                onClick={(event) => {
                  if (event.detail === 0) triggerPan('down');
                }}
              ><DirectionArrow direction="down" /></button>
              <button
                type="button"
                className="pan-button orbit-button orbit-vertical-button orbit-vertical-down"
                aria-label="Orbit down"
                title="Orbit down"
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  triggerOrbitHold('down', true);
                }}
                onPointerUp={(event) => {
                  triggerOrbitHold('down', false);
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }}
                onPointerCancel={() => triggerOrbitHold('down', false)}
                onLostPointerCapture={() => triggerOrbitHold('down', false)}
                onClick={(event) => {
                  if (event.detail === 0) triggerOrbit('down');
                }}
              ><DirectionArrow direction="down" /></button>
            </div>
          </div>
        </div>

        <div className="progress-wrap">
          <div className="progress-meta">
            <span>
              {wrappedCount} of{' '}
              {SECTION_COUNT} sections
              wrapped
            </span>

            <span>
              {wrappedCount ===
              SECTION_COUNT
                ? 'Coil complete'
                : 'Build the coil'}
            </span>
          </div>

          <div
            className="progress-hit"
            role="slider"
            aria-label="Sections wrapped"
            aria-valuemin={0}
            aria-valuemax={
              SECTION_COUNT
            }
            aria-valuenow={
              wrappedCount
            }
            onClick={
              handleProgressBarClick
            }
            onPointerMove={
              handleProgressBarDrag
            }
          >
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${
                    (wrappedCount /
                      SECTION_COUNT) *
                    100
                  }%`,
                }}
              />
            </div>
          </div>
        </div>

        <div className="mode-pill">
          {mode === 'combined' &&
            'Blue field lines show the superposed field from every wrapped section.'}

          {mode === 'all' &&
            'Every section has its own independently rendered, color-coded field.'}

          {mode === 'individual' &&
            (selectedSections.length > 1
              ? `${selectedSections.length} sections are isolated — pink field lines show their combined contribution.`
              : `Section ${
                  (selectedSections[0] ??
                    0) + 1
                } is isolated — pink field lines show only its contribution.`)}

          {mode === 'none' &&
            'The magnetic field visualization is hidden.'}
        </div>
        
        <FieldLegend
          selectedSections={
            selectedSections
          }
          wrappedCount={
            wrappedCount
          }
          mode={mode}
        />
      </div>
    </div>
  );
}