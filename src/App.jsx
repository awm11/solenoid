import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import BuyMeCoffeeButton from './BuyMeCoffee.jsx';

const SITE_URL = 'https://awm11.github.io/';

// public/favicon.svg, resolved against the app's base path so it still
// loads when the app is served from a sub-folder.
const FAVICON_SRC = `${import.meta.env?.BASE_URL ?? '/'}favicon.svg`;

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

// Combined-field line tracing.
//   SEED_RADIUS_FRACTION keeps seeds inside the bore, clear of the winding.
//   LINE_ARC is how far each line is drawn, in world units of arc length.
//   LINE_FADE_FRACTION is how much of each end dissolves into the background.
const SEED_RADIUS_FRACTION = 0.85;
const LINE_ARC = 18;
const LINE_STEP = 0.14;
const LINE_FADE_FRACTION = 0.14;

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
  currentDirection = 1,
) {
  const values = [];

  for (let s = 0; s < activeCount; s++) {
    const weight = weightOf(s) * currentDirection;

    if (weight === 0) {
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
 * Seed points for the combined-field view, chosen by magnetic flux.
 *
 * Each line should stand for the same amount of flux: that is the
 * convention that makes line *density* mean field strength, so the
 * picture reads the way a textbook diagram does.
 *
 * So instead of picking seed positions geometrically, measure the
 * axial flux through the bore at the coil's mid-plane, then place
 * seeds at the radii that cut that flux into `count` equal shares.
 * Seeds stay inside `rMax` (just short of the winding), which also
 * keeps them out of the near-field of individual turns, where a line
 * corkscrews around one wire instead of showing the coil's field.
 */
function axialFluxSeeds(
  elements,
  axisX,
  count,
  rMax,
  samples = 40,
) {
  const probe = new THREE.Vector3();
  const radii = [0];
  const cumulative = [0];
  let total = 0;

  for (let i = 1; i <= samples; i++) {
    const inner = (rMax * (i - 1)) / samples;
    const outer = (rMax * i) / samples;
    const mid = (inner + outer) / 2;

    /*
     * A helix is not quite axisymmetric, so average the axial
     * component over four azimuths at this radius.
     */
    let axial = 0;

    for (let a = 0; a < 4; a++) {
      const theta = (a * Math.PI) / 2;

      fieldAt(
        axisX,
        Math.cos(theta) * mid,
        COIL_RADIUS + Math.sin(theta) * mid,
        elements,
        probe,
      );

      axial += probe.x;
    }

    total +=
      (axial / 4) *
      2 *
      Math.PI *
      mid *
      (outer - inner);

    radii.push(outer);
    cumulative.push(total);
  }

  const seeds = [];

  if (!(Math.abs(total) > 1e-9)) {
    return seeds;
  }

  const goldenAngle =
    Math.PI * (3 - Math.sqrt(5));

  for (let k = 0; k < count; k++) {
    const target =
      (total * (k + 0.5)) / count;

    let i = 1;

    while (
      i < cumulative.length - 1 &&
      Math.abs(cumulative[i]) <
        Math.abs(target)
    ) {
      i++;
    }

    const span =
      cumulative[i] - cumulative[i - 1];

    const f =
      span === 0
        ? 0
        : (target - cumulative[i - 1]) / span;

    const radius =
      radii[i - 1] +
      (radii[i] - radii[i - 1]) *
        Math.min(1, Math.max(0, f));

    const angle = k * goldenAngle;

    seeds.push(
      new THREE.Vector3(
        axisX,
        Math.cos(angle) * radius,
        COIL_RADIUS +
          Math.sin(angle) * radius,
      ),
    );
  }

  return seeds;
}

/*
 * Trace a field line for a fixed ARC LENGTH rather than a fixed number
 * of steps, so the drawn length does not change with the step size.
 *
 * The length is capped because these trajectories are chaotic: two
 * paths that start a hair apart separate fast, mostly when one of them
 * grazes a turn of the winding. Measured against a finely integrated
 * reference, a line is accurate to ~0.1 over the first few units and
 * drifts past ~2 by arc 20, so drawing much beyond LINE_ARC would be
 * drawing noise.
 */
function traceFieldLine(
  seed,
  directionSign,
  elements,
  arcMax = LINE_ARC,
  step = LINE_STEP,
) {
  const linePoints = [];
  const p = seed.clone();
  const b = new THREE.Vector3();
  let travelled = 0;

  while (travelled < arcMax) {
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
      (directionSign * step) / magnitude,
    );

    travelled += step;

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
 * Per-vertex colours that fade both ends of a line into the
 * background. A field line here is a slice of a longer curve, so a
 * hard stop would read as the field ending; fading reads as
 * "continues beyond".
 */
function fadedLineColors(
  points,
  color,
) {
  const base =
    new THREE.Color(color);

  const bg =
    new THREE.Color(0x06090f);

  const fade =
    Math.max(
      2,
      Math.round(
        points.length * LINE_FADE_FRACTION,
      ),
    );

  const colors =
    new Float32Array(points.length * 3);

  const mixed = new THREE.Color();

  for (let i = 0; i < points.length; i++) {
    const edge =
      Math.min(
        i,
        points.length - 1 - i,
      );

    const t =
      Math.min(1, edge / fade);

    mixed
      .copy(bg)
      .lerp(base, 0.15 + 0.85 * t);

    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  }

  return { colors, fade };
}

/*
 * Combined-field view.
 *
 * options:
 *   pitch     - coil pitch, used to find the wrapped coil's mid-plane
 *   seedSpan  - how many sections' worth of coil is wrapped
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
    currentDirection = 1,
    resolution = new THREE.Vector2(800, 600),
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
      currentDirection,
    );

  const count = Math.max(1, Math.round(lineCount));

  /*
   * Mid-plane of the wrapped portion of the coil. During a wrap this
   * slides along with the coil, so the seeds follow it smoothly.
   */
  const axisX =
    coilPointAt(
      (0.5 * seedSpan) / SECTION_COUNT,
      pitch,
    ).x;

  const seeds =
    axialFluxSeeds(
      elements,
      axisX,
      count,
      COIL_RADIUS * SEED_RADIUS_FRACTION,
    );

  const colors = [
    0x4de4ff,
    0x68b5ff,
    0x8c7bff,
  ];

  seeds.forEach(
    (seed, seedIndex) => {
      const forward =
        traceFieldLine(
          seed,
          1,
          elements,
        );

      const backward =
        traceFieldLine(
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

      const color =
        colors[
          seedIndex %
            colors.length
        ];

      const { colors: vertexColors, fade } =
        fadedLineColors(
          traced,
          color,
        );

      // Flat position array for LineGeometry
      const positions = new Float32Array(
        traced.length * 3,
      );
      for (let i = 0; i < traced.length; i++) {
        positions[i * 3]     = traced[i].x;
        positions[i * 3 + 1] = traced[i].y;
        positions[i * 3 + 2] = traced[i].z;
      }

      const geometry = new LineGeometry();
      geometry.setPositions(positions);
      geometry.setColors(vertexColors);

      const material = new LineMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
        linewidth: 2,
        resolution,
      });

      group.add(new Line2(geometry, material));

      /*
       * Arrows only along the part of the line that is fully
       * drawn, so none appear floating in the faded ends.
       */
      /*
       * Arrows are spaced out because line density now carries the
       * field strength; they only need to show direction. They are
       * kept off the faded ends so none float in mid-air.
       */
      addStreamlineArrows(
        group,
        traced.slice(
          fade,
          traced.length - fade,
        ),
        color,
        26,
        0.22,
        0.09,
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
 * Colours for isolated sections, in selection order. The first is the
 * familiar pink, so shift-clicking a second section never recolours
 * the first; none of them is close to the orange of wound wire.
 */
const SELECTION_COLORS = [
  0xff76da,
  0x6cf08c,
  0xffe066,
  0x55a8ff,
  0xb875ff,
  0xff8b5f,
];

function selectionColor(order) {
  return SELECTION_COLORS[order % SELECTION_COLORS.length];
}

const toCssColor = (hex) =>
  `#${hex.toString(16).padStart(6, '0')}`;

/*
 * Isolated field for currently-selected section(s).
 */
function buildSectionField(
  sectionPaths,
  sectionIndices,
  currentDirection = 1,
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
    (sectionIndex, order) => {
      const color =
        selectionColor(order);

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
              color,
              0.78 -
                idx * 0.11,
              72,
            ),
          );
        },
      );

      const arrowDir =
        tangent.clone().multiplyScalar(currentDirection);

      const arrow =
        new THREE.ArrowHelper(
          arrowDir,
          center
            .clone()
            .addScaledVector(
              arrowDir,
              -0.2,
            ),
          0.85,
          validIndices.length > 1
            ? color
            : 0xff9ce7,
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

  // Several isolated sections: one row each, in that section's colour.
  const selectionRows =
    mode === 'individual' &&
    (selectedSections || []).length > 1
      ? selectedSections.map((sectionIndex, order) => ({
          sectionIndex,
          color: toCssColor(
            selectionColor(order),
          ),
        }))
      : null;

  if (selectionRows) {
    title =
      selectionRows.length === 2
        ? `Fields from sections ${selectionRows[0].sectionIndex + 1} & ${selectionRows[1].sectionIndex + 1}`
        : `Fields from ${selectionRows.length} sections`;
  }

  return (
    <div className="field-legend">
      <div className="legend-title">
        {title}
      </div>

      {selectionRows ? (
        selectionRows.map(({ sectionIndex, color }) => (
          <div className="legend-row" key={sectionIndex}>
            <span
              className="legend-dot"
              style={{ background: color, color }}
            />
            <span>Section {sectionIndex + 1}</span>
          </div>
        ))
      ) : (
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
      )}
    </div>
  );
}

/*
 * The 3D screen. It stays mounted while the cross-section is showing,
 * so its coil, camera and selection survive a trip to the other view.
 */
function CoilView({ switcher }) {
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

  // The progress bar pulses on load until the visitor first uses it.
  const [barAttention, setBarAttention] =
    useState(true);

  const [currentReversed, setCurrentReversed] =
    useState(false);

  const stateRef =
    useRef({
      wrappedCount: 0,
      selectedSections: [],
      mode: 'combined',
      combinedLineCount: 18,
      currentDirection: 1,
      showPoles: false,
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

  stateRef.current.currentDirection =
    currentReversed ? -1 : 1;

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
        0x06090f,
      );

    const camera =
      new THREE.PerspectiveCamera(
        43,
        1,
        0.1,
        100,
      );

    camera.position.set(
      11.0,
      5.95,
      19.25,
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

    // Shared resolution vector for LineMaterial (thick field lines).
    // Must match the renderer's pixel size and be updated on resize.
    const lineMaterialResolution =
      new THREE.Vector2(
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

    grid.position.y = -5.0;

    scene.add(grid);

    /*
     * Translucent floor pane sitting just below the grid lines so
     * the grid reads as lines drawn on a surface rather than floating
     * in space.  The slight blue tint matches the scene's colour key.
     */
    const floorMesh =
      new THREE.Mesh(
        new THREE.PlaneGeometry(30, 30),
        new THREE.MeshBasicMaterial({
          color: 0x04060b,
          transparent: true,
          opacity: 0.62,
          depthWrite: false,
        }),
      );

    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.y = -5.01;

    scene.add(floorMesh);

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

    /*
     * Multiply a #rrggbb colour toward black. factor < 1 darkens.
     */
    function shade(hex, factor) {
      const n = parseInt(hex.slice(1), 16);

      const channel = (shift) =>
        Math.max(
          0,
          Math.min(
            255,
            Math.round(((n >> shift) & 255) * factor),
          ),
        );

      return (
        '#' +
        [16, 8, 0]
          .map((s) =>
            channel(s)
              .toString(16)
              .padStart(2, '0'),
          )
          .join('')
      );
    }

    function createPoleBadge(
      letter,
      fillColor,
      borderColor,
    ) {
      const SIZE = 320;
      const canvas =
        document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;

      const ctx = canvas.getContext('2d');
      const cx = SIZE / 2;
      const cy = SIZE / 2;

      /*
       * Opaque disk behind the glyph, so the badge reads as a solid
       * object rather than a decal floating over the field lines.
       * Everything outside the disk stays transparent.
       */
      const diskR = SIZE / 2 - 4;

      ctx.beginPath();
      ctx.arc(cx, cy, diskR, 0, Math.PI * 2);
      ctx.fillStyle = '#0b1018';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, diskR - 2, 0, Math.PI * 2);
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 4;
      ctx.globalAlpha = 0.55;
      ctx.stroke();
      ctx.globalAlpha = 1;

      /*
       * Both letters share one construction, taken from the standard
       * end-view convention:
       *
       *   - a straight diagonal through the centre, from A to the
       *     diametrically opposite B,
       *   - a circular arc leaving A and another leaving B, each
       *     sweeping ~122 degrees around the letter circle,
       *   - an arrowhead on the open end of each arc.
       *
       * N sweeps anticlockwise (current toward the viewer), S sweeps
       * clockwise (current away). That is the whole difference — the
       * two glyphs are the same figure run in opposite directions.
       */
      const R = 88;
      const ccw = letter === 'N';
      const startDeg = ccw ? 137 : 153;
      const sweepDeg = ccw ? 122 : -122;

      const DEG = Math.PI / 180;

      // Math-convention angle (anticlockwise, y up) -> canvas point.
      function at(deg, radius = R) {
        return [
          cx + radius * Math.cos(deg * DEG),
          cy - radius * Math.sin(deg * DEG),
        ];
      }

      ctx.strokeStyle = fillColor;
      ctx.lineWidth = Math.round(R * 0.115);
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';

      /*
       * Arrowhead as a filled isosceles triangle: apex at the tip,
       * base square to the direction of travel. Takes whichever
       * stroke colour is current, so each head matches its stroke.
       */
      function arrowhead(tipX, tipY, dirDeg, len) {
        const dir = dirDeg * DEG;

        // Unit vector along travel (canvas y grows downward).
        const dx = Math.cos(dir);
        const dy = -Math.sin(dir);

        // Perpendicular, for the two base corners.
        const px = -dy;
        const py = dx;

        const halfBase = len * 0.46;
        const baseX = tipX - len * dx;
        const baseY = tipY - len * dy;

        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(
          baseX + px * halfBase,
          baseY + py * halfBase,
        );
        ctx.lineTo(
          baseX - px * halfBase,
          baseY - py * halfBase,
        );
        ctx.closePath();
        ctx.fill();
      }

      // Arc drawn as a polyline so the sweep direction stays explicit.
      function sweepArc(fromDeg, deltaDeg, radius) {
        const steps = 56;
        ctx.beginPath();
        for (let i = 0; i <= steps; i++) {
          const [x, y] = at(
            fromDeg + (deltaDeg * i) / steps,
            radius,
          );
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      const aDeg = startDeg;
      const bDeg = startDeg + 180;

      /*
       * The straight diagonal: a diameter from A to B. Drawn a little
       * thinner than the arcs, and in the brighter tone, so the two
       * parts of the glyph read apart from each other.
       */
      const [ax, ay] = at(aDeg);
      const [bx, by] = at(bDeg);
      ctx.lineWidth = Math.round(R * 0.065);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();

      // The two arcs, each curling off one end of the diagonal,
      // in a deeper shade of the pole colour.
      ctx.strokeStyle = shade(fillColor, 0.52);
      ctx.lineWidth = Math.round(R * 0.13);

      sweepArc(aDeg, sweepDeg, R);
      sweepArc(bDeg, sweepDeg, R);

      // Arrowheads on the open end of each arc, along the tangent.
      const headLen = R * 0.34;
      for (const endDeg of [aDeg + sweepDeg, bDeg + sweepDeg]) {
        const [tx, ty] = at(endDeg);
        const tangent = endDeg + (ccw ? 90 : -90);
        arrowhead(tx, ty, tangent, headLen);
      }

      /*
       * The dashed ring outside the letter repeats the same sense of
       * rotation, so the glyph and the current agree at a glance.
       */
      const ringR = R * 1.3;
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = Math.round(R * 0.075);
      ctx.setLineDash([R * 0.17, R * 0.12]);
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      for (const markDeg of [135, 315]) {
        const [tx, ty] = at(markDeg, ringR);
        const tangent = markDeg + (ccw ? 90 : -90);
        arrowhead(tx, ty, tangent, R * 0.32);
      }

      const texture =
        new THREE.CanvasTexture(canvas);
      texture.anisotropy = 8;

      /*
       * The reverse: just the letter, plainly set. Seen from behind
       * the coil the badge is only there to say which end this is,
       * so it carries none of the current detail and sits smaller.
       */
      const backCanvas =
        document.createElement('canvas');
      backCanvas.width = SIZE;
      backCanvas.height = SIZE;

      const bctx = backCanvas.getContext('2d');

      bctx.beginPath();
      bctx.arc(cx, cy, diskR, 0, Math.PI * 2);
      bctx.fillStyle = '#0b1018';
      bctx.fill();

      bctx.beginPath();
      bctx.arc(cx, cy, diskR - 2, 0, Math.PI * 2);
      bctx.strokeStyle = borderColor;
      bctx.lineWidth = 4;
      bctx.globalAlpha = 0.55;
      bctx.stroke();
      bctx.globalAlpha = 1;

      bctx.font =
        '700 150px system-ui, -apple-system, sans-serif';
      bctx.textAlign = 'center';
      bctx.textBaseline = 'middle';
      bctx.fillStyle = fillColor;
      bctx.fillText(letter, cx, cy + 6);

      const backTexture =
        new THREE.CanvasTexture(backCanvas);
      backTexture.anisotropy = 8;

      /*
       * Two single-sided planes back to back rather than one
       * double-sided one, so each face can carry its own artwork and
       * its own size. Meshes, not sprites: a sprite is always a full
       * billboard, and the badge is only allowed to turn part of the
       * way toward the camera (see the clamp in the animation loop).
       */
      const badge = new THREE.Group();

      const front =
        new THREE.Mesh(
          new THREE.PlaneGeometry(2.4, 2.4),
          new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            depthTest: true,
            side: THREE.FrontSide,
          }),
        );

      const back =
        new THREE.Mesh(
          new THREE.PlaneGeometry(1.5, 1.5),
          new THREE.MeshBasicMaterial({
            map: backTexture,
            transparent: true,
            depthTest: true,
            side: THREE.FrontSide,
          }),
        );

      // Turned to face the other way, which also un-mirrors it.
      back.rotation.y = Math.PI;

      // A hair apart so the two never fight for the same depth.
      front.position.z = 0.002;
      back.position.z = -0.002;

      badge.add(front);
      badge.add(back);

      poleGroup.add(badge);
      return badge;
    }

    // How far a pole badge may swivel from facing straight out
    // along the coil axis.
    const POLE_MAX_TURN = THREE.MathUtils.degToRad(20);

    const poleMarkers = [
      createPoleBadge('N', '#ff2231', '#ff3a46'),
      createPoleBadge('S', '#1f6bff', '#3b81ff'),
    ];

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

        /*
         * poleMarkers[0] is always the north sphere (red).
         * poleMarkers[1] is always the south sphere (blue).
         * Standard current direction: north at the lastWrapped end,
         * south at the first end.  When reversed, swap the ends.
         */
        const reversed =
          stateRef.current.currentDirection === -1;

        const northEnd = reversed ? firstEndpoint : lastWrappedEndpoint;
        const southEnd = reversed ? lastWrappedEndpoint : firstEndpoint;

        /*
         * Each badge caps one end of the wound section, centred on the
         * coil's central axis (y = 0, z = COIL_RADIUS, which is what
         * the helix in coilPoint winds around).
         *
         * The outward direction is taken from the two ends relative to
         * each other, not to the full coil's midpoint: while wrapping
         * is part-way through, both ends can sit on the same side of
         * that midpoint, which would put both badges at one end.
         */
        const midX =
          (northEnd.x + southEnd.x) / 2;

        const northSign =
          Math.sign(northEnd.x - midX) || 1;

        [
          [poleMarkers[0], northEnd, northSign],
          [poleMarkers[1], southEnd, -northSign],
        ].forEach(([badge, end, sign]) => {
          badge.userData.outwardSign = sign;

          badge.position.set(
            end.x + sign * 0.85,
            0,
            COIL_RADIUS,
          );
        });
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

        // A selected section wears the same colour as its field.
        const selectedColor =
          isSelected
            ? selectionColor(selections.indexOf(i))
            : null;

        const wireMaterial =
          new THREE.MeshStandardMaterial({
            color: isSelected
              ? selectedColor
              : isWrapped
                ? 0xffa15b
                : 0xe8f5ff,

            emissive:
              isSelected
                ? new THREE.Color(selectedColor).multiplyScalar(0.36)
                : new THREE.Color(
                    isWrapped
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
                  color: selectedColor,
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
                  color: selectedColor,
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
            .normalize()
            .multiplyScalar(stateRef.current.currentDirection);

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
          {
            pitch: coilPitchRef.current,
            currentDirection: stateRef.current.currentDirection,
            resolution: lineMaterialResolution,
          },
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
          stateRef.current.currentDirection,
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
              currentDirection: stateRef.current.currentDirection,
              resolution: lineMaterialResolution,
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
            stateRef.current.currentDirection,
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

    function handleReverseCurrentDirection(
      reversed,
    ) {
      stateRef.current.currentDirection =
        reversed ? -1 : 1;

      /*
       * Rebuild fields so arrows flip.
       * Wire rebuild is also needed to update pole positions.
       */
      rebuildFields(
        state.sectionPaths,
        stateRef.current.wrappedCount,
        stateRef.current.selectedSections,
      );

      rebuildWire(
        state.sectionPaths,
        stateRef.current.wrappedCount,
        stateRef.current.selectedSections,
      );
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

      // Arrow keys belong to whichever screen is showing.
      if (mount.offsetParent === null) {
        return;
      }

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

      // Hidden behind the other screen: keep the last good size.
      if (!width || !height) {
        return;
      }

      camera.aspect =
        width /
        Math.max(height, 1);

      camera.updateProjectionMatrix();

      renderer.setSize(
        width,
        height,
      );

      lineMaterialResolution.set(width, height);
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

      // Nothing to draw while the cross-section screen is showing.
      if (mount.offsetParent === null) {
        previousFrameTime = 0;
        return;
      }

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

          poleGroup.visible =
            stateRef.current.showPoles &&
            animationTo >= 16;

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

          const dir = stateRef.current.currentDirection;
          const TAU = Math.PI * 2;
          const pulsePosition =
            ((now * 0.0022 * dir -
              marker.userData.pulsePhase) %
              TAU +
              TAU) %
            TAU;

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

      /*
       * Pole badges turn toward the camera, but only up to
       * POLE_MAX_TURN from their rest facing of +Z. Past that they
       * stop, so an orbit round the back leaves them edge-on rather
       * than spinning to follow.
       */
      if (poleGroup.visible) {
        for (const badge of poleMarkers) {
          /*
           * Rest facing is straight out along the coil axis, away from
           * the winding: yaw of +90 deg at the +X end, -90 at the -X
           * end, level in pitch. The badge turns from there toward the
           * camera, but no further than POLE_MAX_TURN on either axis.
           */
          const restYaw =
            (badge.userData.outwardSign || 1) *
            (Math.PI / 2);

          const toCamera =
            camera.position
              .clone()
              .sub(badge.position);

          // Wrap into [-PI, PI] so an orbit past the back of the
          // scene turns the short way rather than unwinding.
          const wrap = (a) =>
            Math.atan2(
              Math.sin(a),
              Math.cos(a),
            );

          const yaw =
            restYaw +
            THREE.MathUtils.clamp(
              wrap(
                Math.atan2(toCamera.x, toCamera.z) -
                  restYaw,
              ),
              -POLE_MAX_TURN,
              POLE_MAX_TURN,
            );

          // Yaw only: the badge stays upright and never tips to
          // follow the camera's height.
          badge.rotation.set(0, yaw, 0, 'YXZ');
        }
      }

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
          stateRef.current.showPoles = visible;
          poleGroup.visible =
            visible &&
            stateRef.current.wrappedCount >= 16;
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

      reverseCurrentDirection:
        handleReverseCurrentDirection,
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

  // One click flips the current, whichever way it is flowing.
  const handleCurrentReverseToggle =
    () => {
      const reversed =
        !currentReversed;

      setCurrentReversed(reversed);

      mountRef.current?._magneticTool
        ?.reverseCurrentDirection(reversed);
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

  const modeCaption = {
    combined:
      'Blue field lines show the superposed field from every wrapped section.',
    all:
      'Every section has its own independently rendered, color-coded field.',
    individual:
      selectedSections.length > 1
        ? `${selectedSections.length} sections are isolated — each one's field is drawn in its own colour.`
        : `Section ${
            (selectedSections[0] ?? 0) + 1
          } is isolated — pink field lines show only its contribution.`,
    none: 'The magnetic field visualization is hidden.',
  }[mode];

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
              circle at 12% 6%,
              rgba(20, 70, 160, 0.18),
              transparent 32%
            ),
            radial-gradient(
              circle at 88% 94%,
              rgba(10, 50, 120, 0.12),
              transparent 34%
            ),
            #04060e;
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
          background: #05080d;
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
        /*
         * On wide screens the bar runs to the bottom of the panel so
         * the coffee button can take the bottom-left cell; it passes
         * pointer events through everywhere but its controls.
         */
        .top-bar {
          top: 20px;
          left: 22px;
          right: 20px;
          bottom: 20px;
          display: grid;
          grid-template-columns: minmax(300px, 1fr) auto;
          grid-template-areas:
            "title  controls"
            "help   controls"
            ".      ."
            "bottom bottom";
          grid-template-rows: auto auto 1fr auto;
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

        /* Reverse current: a one-shot action, not an on/off state. */
        .reverse-button {
          font: inherit;
          font-size: 12px;
          font-weight: 800;
          transition:
            transform .15s ease,
            border-color .15s ease,
            background .15s ease;
        }

        .reverse-button:hover {
          transform: translateY(-1px);
          border-color: rgba(255, 106, 91, 0.7);
          background: rgba(68, 12, 20, 0.9);
        }

        .reverse-button:active {
          transform: translateY(0) scale(0.97);
        }

        .reverse-button:focus-visible {
          outline: 2px solid rgba(255, 120, 100, 0.6);
          outline-offset: 1px;
        }

        .reverse-icon {
          font-size: 14px;
          line-height: 1;
        }

        /*
         * On load the progress bar pulses a red ring with a "Click
         * here" pill on it, until the visitor first uses the bar or
         * the Wrap / Unwrap buttons.
         */
        @keyframes progress-ring {
          0% {
            box-shadow:
              0 0 0 0 rgba(255, 60, 72, 0.85),
              0 0 0 0 rgba(255, 60, 72, 0.4);
            border-color: rgba(255, 70, 80, 0.95);
          }
          70% {
            box-shadow:
              0 0 0 10px rgba(255, 60, 72, 0),
              0 0 18px 2px rgba(255, 60, 72, 0.28);
            border-color: rgba(255, 70, 80, 0.55);
          }
          100% {
            box-shadow:
              0 0 0 0 rgba(255, 60, 72, 0),
              0 0 0 0 rgba(255, 60, 72, 0);
            border-color: rgba(255, 70, 80, 0.3);
          }
        }

        @keyframes hint-pulse {
          0%, 100% {
            transform: translate(-50%, -50%) scale(1);
          }
          50% {
            transform: translate(-50%, -50%) scale(1.08);
          }
        }

        .progress-bar.attention {
          animation: progress-ring 1.4s ease-out infinite;
        }

        .progress-hit {
          position: relative;
        }

        .bar-hint {
          position: absolute;
          left: 50%;
          top: 50%;
          z-index: 1;
          padding: 3px 11px;
          border-radius: 999px;
          background: #e0283a;
          color: #ffffff;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.03em;
          white-space: nowrap;
          pointer-events: none;
          box-shadow: 0 0 14px rgba(255, 60, 72, 0.55);
          transform: translate(-50%, -50%);
          animation: hint-pulse 1.4s ease-in-out infinite;
        }

        @media (prefers-reduced-motion: reduce) {
          .progress-bar.attention,
          .bar-hint {
            animation: none;
          }

          .progress-bar.attention {
            box-shadow: 0 0 0 3px rgba(255, 60, 72, 0.6);
          }
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

        /*
         * Brand mark: the favicon sits beside the title as the logo,
         * and tips a little to the right when pointed at.
         */
        .brand-row {
          display: flex;
          align-items: center;
          gap: 14px;
        }

        .brand-text {
          min-width: 0;
        }

        .brand-mark {
          flex: none;
          display: block;
          width: 52px;
          height: 52px;
          border-radius: 12px;
          pointer-events: auto;
          transition: transform .22s cubic-bezier(.34, 1.56, .64, 1);
        }

        .brand-mark img {
          display: block;
          width: 100%;
          height: 100%;
        }

        .brand-mark:hover,
        .brand-mark:focus-visible {
          transform: scale(1.1) rotate(8deg);
        }

        .brand-mark:focus-visible {
          outline: 2px solid rgba(98, 230, 255, 0.6);
          outline-offset: 3px;
        }

        /*
         * Buy me a coffee: bottom-left corner. The embed is a fixed
         * 250 × 60 document, so it is scaled as a whole and the frame
         * clips to the scaled size.
         */
        .coffee-dock {
          --coffee-scale: 0.72;
          grid-area: coffee;
          justify-self: start;
          align-self: end;
          pointer-events: auto;
        }

        .coffee-embed-frame {
          display: block;
          width: calc(250px * var(--coffee-scale));
          height: calc(60px * var(--coffee-scale));
          overflow: hidden;
          border-radius: 10px;
          background: #FFDD00;
          box-shadow: 0 8px 22px rgba(0, 0, 0, 0.38);
          transition: transform .15s ease;
        }

        .coffee-embed-frame:hover {
          transform: translateY(-1px);
        }

        .coffee-embed {
          display: block;
          width: 250px;
          height: 60px;
          border: 0;
          transform: scale(var(--coffee-scale));
          transform-origin: 0 0;
        }

        /*
         * Desktop bottom row: mode caption left, view switcher dead
         * centre (equal side columns), coffee button in the corner.
         */
        .bottom-row {
          grid-area: bottom;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
          align-items: center;
          gap: 12px;
        }

        /* grid-area: auto, or its narrow-screen area name would add
           an implicit row to this grid. */
        .bottom-row .coffee-dock {
          grid-area: auto;
          align-self: center;
          justify-self: end;
        }

        .mode-pill.in-row {
          justify-self: start;
          min-width: 0;
        }

        /* Unwrap · Wrap · progress bar, on both screens. */
        .progress-row {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .progress-row .progress-hit {
          flex: 1 1 auto;
          min-width: 0;
        }

        .progress-row .control {
          flex: none;
          pointer-events: auto;
        }

        /* Narrow screens only (see the 820px breakpoint). */
        .mode-pill.floating {
          display: none;
          position: absolute;
          left: 22px;
          bottom: 20px;
          max-width: calc(100% - 44px);
          z-index: 4;
        }

        .progress-wrap .progress-switch {
          display: none;
        }

        .mode-pill {
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

        /* Bottom-left, above the progress bar, level with the pad. */
        .field-legend {
          position: absolute;
          left: 22px;
          bottom: 144px;
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
          bottom: 74px;
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

        /*
         * The view switcher, centred under the progress bar. Shared by
         * both screens, so it sits in the same relative spot on each.
         */
        .progress-switch {
          display: flex;
          justify-content: center;
          margin-top: 4px;
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
          bottom: 144px;
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
            bottom: 16px;
            grid-template-columns: minmax(0, 1fr);
            grid-template-areas:
              "title"
              "controls"
              "help"
              "."
              "bottom";
            grid-template-rows: auto auto auto 1fr auto;
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

          /*
           * Stacked layout: the bottom row keeps only the coffee button,
           * still in the bottom-right corner. Its switcher and caption
           * give way to the narrow-screen copies (switcher under the
           * progress bar, caption bottom-left beside the coffee).
           */
          .bottom-switch,
          .mode-pill.in-row {
            display: none;
          }

          .bottom-row .coffee-dock {
            --coffee-scale: 0.6;
            grid-column: 3;
          }

          .mode-pill.floating {
            display: block;
            max-width: calc(100% - 44px - 162px);
          }

          .progress-wrap {
            bottom: 92px;
          }

          .progress-wrap .progress-switch {
            display: flex;
          }

          .direction-controls {
            bottom: 202px;
          }

          /* The coffee button owns the bottom-right corner, so the
             legend sits above the progress bar on the left. */
          .field-legend {
            bottom: 200px;
          }

          .brand-mark {
            width: 44px;
            height: 44px;
          }
        }

        @media (max-width: 620px) {
          .field-legend {
            display: none;
          }

          .direction-controls {
            right: 16px;
            bottom: 194px;
            gap: 10px;
          }

          /*
           * Phones: beside the coffee button the caption would wrap
           * into the switcher, so it moves above the progress bar,
           * left of the pan pad, and grows upwards.
           */
          .mode-pill.floating {
            bottom: 194px;
            max-width: calc(100% - 44px - 140px);
            font-size: 11px;
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
            <div className="brand-row">
              <a
                className="brand-mark"
                href={SITE_URL}
                title="awm physics"
                aria-label="awm physics home page"
              >
                <img
                  src={FAVICON_SRC}
                  alt=""
                  width="52"
                  height="52"
                />
              </a>

              <div className="brand-text">
                <div className="kicker">
                  Magnetism · 3D exploration
                </div>

                <h1 className="title">
                  From straight wire to
                  solenoid
                </h1>
              </div>
            </div>
          </div>

          <div className="top-controls">
            <div className="toolbar">
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

                <button
                  type="button"
                  className="current-toggle reverse-button"
                  onClick={handleCurrentReverseToggle}
                  title="Reverse the direction of current flow, flipping the field and swapping pole labels"
                >
                  <span className="reverse-icon" aria-hidden="true">⇄</span>
                  <span>Reverse current</span>
                </button>

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

          {/*
            Desktop bottom row: view switcher, mode caption, coffee.
            On narrow screens this row dissolves (display: contents):
            its switcher and caption hide in favour of the copies placed
            for small screens, and the coffee button drops in under the
            help text.
          */}
          <div className="bottom-row">
            <div className="mode-pill in-row">
              {modeCaption}
            </div>

            <div className="bottom-switch">
              {switcher}
            </div>

            <div className="coffee-dock">
              <BuyMeCoffeeButton />
            </div>
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

          {/* Unwrap · Wrap · progress */}
          <div
            className="progress-row"
            onPointerDownCapture={() => setBarAttention(false)}
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
              {barAttention && (
                <span className="bar-hint" aria-hidden="true">
                  Click here
                </span>
              )}

              <div
                className={`progress-bar${
                  barAttention ? ' attention' : ''
                }`}
              >
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

          <div className="progress-switch">
            {switcher}
          </div>
        </div>

        {/* Narrow screens: the caption floats in the bottom-left corner. */}
        <div className="mode-pill floating">
          {modeCaption}
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
/* =====================================================================
 * Cross-section screen
 *
 * A slice through the solenoid along its axis. Every turn pierces the
 * page twice: at the top (current out of the page, ⊙) and at the bottom
 * (current into the page, ⊗). In the plane of the slice each piercing
 * acts like a long straight wire, so the in-plane field is the 2D
 * superposition of those line currents (units with μ0/2π = 1):
 *
 *   B(r) = Σ q_k · ẑ × (r − r_k) / |r − r_k|²
 *
 * The field lines are then exactly the level curves of the vector
 * potential A(r) = −Σ q_k ln|r − r_k|. Contours of A drawn at equal
 * spacing give lines whose density *is* the field strength, which is
 * what lets "adjacent turns cancel, opposite sides add" show up
 * honestly: lines thin out where fields cancel and crowd where they add.
 * ===================================================================== */

const SLICE_R = 1;
const SLICE_PITCH = 0.62;
const SLICE_MAX_TURNS = 10;
const SLICE_START_TURNS = 3;
const SLICE_WIRE_R = 0.12;
const SLICE_TURN_LENGTH = Math.PI * 2 * SLICE_R;

// World height kept in view; the width follows the coil (see draw).
const SLICE_WORLD_H = 4.5;
// Room kept either side of the coil for its fringe field, world units.
const SLICE_WORLD_MARGIN = 4.6;

const SLICE_WRAP_MS = 1900;
// Per-turn time when jumping several turns from the progress bar.
const SLICE_JUMP_MS = 650;
// How far the far end of a wrapping turn lags its near end (0..1).
const SLICE_WRAP_STAGGER = 0.25;
// Oblique projection: screen x shift per unit of depth. Negative makes
// the front half of each turn bow to the left, as in a textbook sketch.
const SLICE_OBLIQUE = -0.24;

const SLICE_A_COLOR = '#ffb547';
const SLICE_B_COLOR = '#ff5fa8';
const SLICE_CURRENT_COLOR = '#ff4a5a';
const SLICE_BG = '#05080d';

const sliceClamp = (v, lo, hi) =>
  Math.min(hi, Math.max(lo, v));

const sliceSmooth = (t) => t * t * (3 - 2 * t);

function sliceEase(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function sliceTurnX(i) {
  return i * SLICE_PITCH;
}

/*
 * A point on the turn that is part-way through wrapping.
 *
 * s runs along the wire from the turn's top crossing. Unwrapped, the
 * wire lies straight along the top of the slice; wrapped, it is a loop
 * round the axis. Each point rolls round the axis by its own angle
 * while sliding home in x, so the wire wraps onto the coil's surface
 * rather than cutting through the bore. The near end leads the far end
 * by SLICE_WRAP_STAGGER. The fourth value is the roll angle, used to
 * find where the wire passes through the page.
 */
function sliceFormingPoint(i, s, E) {
  const u = sliceSmooth(
    sliceClamp(
      (E - SLICE_WRAP_STAGGER * (s / SLICE_TURN_LENGTH)) /
        (1 - SLICE_WRAP_STAGGER),
      0,
      1,
    ),
  );

  const phi = s / SLICE_R;
  const theta = u * phi;
  const x0 = sliceTurnX(i);

  const xLoop =
    phi <= Math.PI
      ? x0
      : x0 + (SLICE_PITCH * (phi - Math.PI)) / Math.PI;

  const xStraight = x0 + s;

  return [
    xStraight + (xLoop - xStraight) * u,
    SLICE_R * Math.cos(theta),
    SLICE_R * Math.sin(theta),
    theta,
  ];
}

function sliceCrossingFromId(id, dir) {
  if (!id) return null;

  const top = id[0] === 't';
  const turn = Number(id.slice(1));

  return {
    id,
    turn,
    side: top ? 'top' : 'bottom',
    x: sliceTurnX(turn),
    y: top ? SLICE_R : -SLICE_R,
    I: top ? dir : -dir,
    w: 1,
  };
}

/*
 * Every place the wire pierces the page, with its current sign I
 * (+1 out of the page, −1 into it) and a weight w used to fade
 * crossings in while a turn forms.
 *
 * Current runs down the front of each turn (for dir = +1), so it comes
 * out of the page at the top and goes into it at the bottom.
 */
function sliceCrossings(geo, dir) {
  const out = [];

  for (let i = 0; i < geo.base; i++) {
    out.push(sliceCrossingFromId(`t${i}`, dir));
    out.push(sliceCrossingFromId(`b${i}`, dir));
  }

  if (geo.E == null) return out;

  const i = geo.base;
  const x0 = sliceTurnX(i);

  // Top: the wire leaves the page here as soon as it starts to curl.
  out.push({
    id: null,
    turn: i,
    side: 'top',
    x: x0,
    y: SLICE_R,
    I: dir,
    w: sliceSmooth(sliceClamp(geo.E / 0.18, 0, 1)),
    forming: true,
  });

  /*
   * Bottom: wherever the curling wire's roll angle passes through π.
   * Rolling forward through π the wire goes from the front to the back
   * of the page (into it); rolling back through π it comes out. A
   * crossing born at the free end fades in as it slides away from it.
   */
  const samples = 240;
  let prev = sliceFormingPoint(i, 0, geo.E);

  for (let k = 1; k <= samples; k++) {
    const s = (k / samples) * SLICE_TURN_LENGTH;
    const cur = sliceFormingPoint(i, s, geo.E);
    const a = prev[3] - Math.PI;
    const b = cur[3] - Math.PI;

    if ((a < 0) !== (b < 0)) {
      const t = a / (a - b);
      const forward = b > a ? 1 : -1;
      const fromEnd = 1 - (k - 1 + t) / samples;

      out.push({
        id: null,
        turn: i,
        side: 'bottom',
        x: prev[0] + (cur[0] - prev[0]) * t,
        y: -SLICE_R,
        I: -dir * forward,
        w: sliceSmooth(sliceClamp(fromEnd / 0.1, 0, 1)),
        forming: true,
      });
    }

    prev = cur;
  }

  return out;
}

function sliceFieldAt(wires, x, y) {
  let bx = 0;
  let by = 0;

  for (const w of wires) {
    const q = w.I * w.w;
    if (!q) continue;

    const dx = x - w.x;
    const dy = y - w.y;
    const d2 = Math.max(dx * dx + dy * dy, 1e-6);

    bx -= (q * dy) / d2;
    by += (q * dx) / d2;
  }

  return [bx, by];
}

function sliceView(width, height, cx, cy, scale) {
  return {
    width,
    height,
    cx,
    cy,
    scale,
    sx(x) {
      return (x - cx) * scale + width / 2;
    },
    sy(y) {
      return height / 2 - (y - cy) * scale;
    },
    wx(px) {
      return cx + (px - width / 2) / scale;
    },
    wy(py) {
      return cy - (py - height / 2) / scale;
    },
    // 3D point -> screen, with depth shown as an oblique x shift.
    project(p) {
      return [
        this.sx(p[0] + SLICE_OBLIQUE * p[2]),
        this.sy(p[1]),
      ];
    },
  };
}

/*
 * Potential A and field strength |B| sampled on a screen-space grid.
 * Nodes inside a wire's marker are flagged so contours and colour skip
 * the singularity there.
 */
function sliceGrid(wires, view, step, cutoff) {
  const nx = Math.ceil(view.width / step) + 2;
  const ny = Math.ceil(view.height / step) + 2;
  const count = nx * ny;

  const A = new Float32Array(count);
  const B = new Float32Array(count);
  const near = new Uint8Array(count);

  const active = wires.filter(
    (w) => Math.abs(w.I * w.w) > 1e-4,
  );
  const n = active.length;
  const wx = new Float64Array(n);
  const wy = new Float64Array(n);
  const q = new Float64Array(n);
  const cut2 = new Float64Array(n);

  for (let k = 0; k < n; k++) {
    wx[k] = active[k].x;
    wy[k] = active[k].y;
    q[k] = active[k].I * active[k].w;
    cut2[k] = Math.abs(q[k]) > 0.2 ? cutoff * cutoff : 0;
  }

  const inv = 1 / view.scale;
  let idx = 0;

  for (let j = 0; j < ny; j++) {
    const y = view.cy + (view.height / 2 - j * step) * inv;

    for (let i = 0; i < nx; i++, idx++) {
      const x = view.cx + (i * step - view.width / 2) * inv;

      let a = 0;
      let bx = 0;
      let by = 0;
      let nr = 0;

      for (let k = 0; k < n; k++) {
        const dx = x - wx[k];
        const dy = y - wy[k];
        let d2 = dx * dx + dy * dy;

        if (d2 < cut2[k]) nr = 1;
        if (d2 < 1e-8) d2 = 1e-8;

        const qk = q[k];
        a -= qk * Math.log(d2);

        const f = qk / d2;
        bx -= f * dy;
        by += f * dx;
      }

      // −q ln d² is twice −q ln d.
      A[idx] = a * 0.5;
      B[idx] = Math.sqrt(bx * bx + by * by);
      near[idx] = nr;
    }
  }

  return { nx, ny, step, A, B, near };
}

/*
 * Marching squares over the potential: one contour per multiple of
 * `spacing`. Also proposes arrow sites, roughly one per field line per
 * arrowCell of screen.
 */
function sliceContours(grid, spacing, arrowCell) {
  const { nx, ny, step, A, near } = grid;

  let segs = new Float32Array(32768);
  let n = 0;

  const arrowKeys = new Set();
  const arrows = [];

  function push(x1, y1, x2, y2, k) {
    if (n + 4 > segs.length) {
      const bigger = new Float32Array(segs.length * 2);
      bigger.set(segs);
      segs = bigger;
    }

    segs[n++] = x1 * step;
    segs[n++] = y1 * step;
    segs[n++] = x2 * step;
    segs[n++] = y2 * step;

    const mx = ((x1 + x2) / 2) * step;
    const my = ((y1 + y2) / 2) * step;
    const key =
      ((k + 50000) * 4096 + Math.floor(my / arrowCell)) * 4096 +
      Math.floor(mx / arrowCell);

    if (!arrowKeys.has(key)) {
      arrowKeys.add(key);
      arrows.push([mx, my]);
    }
  }

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const i0 = j * nx + i;
      const i1 = i0 + 1;
      const i3 = i0 + nx;
      const i2 = i3 + 1;

      if (near[i0] | near[i1] | near[i2] | near[i3]) continue;

      const v0 = A[i0];
      const v1 = A[i1];
      const v2 = A[i2];
      const v3 = A[i3];

      const lo = Math.min(v0, v1, v2, v3);
      const hi = Math.max(v0, v1, v2, v3);
      const k0 = Math.ceil(lo / spacing);
      const k1 = Math.floor(hi / spacing);

      // Many levels in one cell means a singularity: skip it.
      if (k1 < k0 || k1 - k0 > 3) continue;

      for (let k = k0; k <= k1; k++) {
        const L = k * spacing;
        const a0 = v0 > L;
        const a1 = v1 > L;
        const a2 = v2 > L;
        const a3 = v3 > L;

        // Edge crossings in order: top, right, bottom, left.
        const px = [];
        const py = [];
        const at = [];

        if (a0 !== a1) {
          px.push(i + (L - v0) / (v1 - v0));
          py.push(j);
          at.push(0);
        }
        if (a1 !== a2) {
          px.push(i + 1);
          py.push(j + (L - v1) / (v2 - v1));
          at.push(1);
        }
        if (a3 !== a2) {
          px.push(i + (L - v3) / (v2 - v3));
          py.push(j + 1);
          at.push(2);
        }
        if (a0 !== a3) {
          px.push(i);
          py.push(j + (L - v0) / (v3 - v0));
          at.push(3);
        }

        if (px.length === 2) {
          push(px[0], py[0], px[1], py[1], k);
        } else if (px.length === 4) {
          // Saddle: decide which corners the centre joins.
          const c = (v0 + v1 + v2 + v3) / 4;

          if (c > L === a0) {
            push(px[0], py[0], px[1], py[1], k);
            push(px[2], py[2], px[3], py[3], k);
          } else {
            push(px[0], py[0], px[3], py[3], k);
            push(px[1], py[1], px[2], py[2], k);
          }
        }
      }
    }
  }

  return { segs, count: n / 4, arrows };
}

// Keep arrow sites at least minDist apart.
function sliceThin(points, minDist) {
  const cell = minDist;
  const buckets = new Map();
  const kept = [];
  const min2 = minDist * minDist;

  for (const p of points) {
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    let ok = true;

    for (let dy = -1; dy <= 1 && ok; dy++) {
      for (let dx = -1; dx <= 1 && ok; dx++) {
        const list = buckets.get(`${cx + dx},${cy + dy}`);
        if (!list) continue;

        for (const o of list) {
          const ex = o[0] - p[0];
          const ey = o[1] - p[1];
          if (ex * ex + ey * ey < min2) {
            ok = false;
            break;
          }
        }
      }
    }

    if (!ok) continue;

    kept.push(p);
    const key = `${cx},${cy}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p);
  }

  return kept;
}

// Field strength colour ramp: transparent → deep blue → cyan → white.
const SLICE_STRENGTH_STOPS = [
  [0.0, 5, 8, 13, 0],
  [0.22, 10, 34, 78, 0.5],
  [0.5, 16, 96, 164, 0.66],
  [0.78, 70, 186, 232, 0.78],
  [1.0, 218, 247, 255, 0.9],
];

function sliceStrengthCanvas(grid, b0, bmax, alpha, cache) {
  const { nx, ny, B, near } = grid;

  let canvas = cache.canvas;
  if (!canvas || canvas.width !== nx || canvas.height !== ny) {
    canvas = document.createElement('canvas');
    canvas.width = nx;
    canvas.height = ny;
    cache.canvas = canvas;
  }

  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(nx, ny);
  const data = img.data;
  const norm = Math.log1p(bmax / b0);
  const stops = SLICE_STRENGTH_STOPS;

  for (let idx = 0, o = 0; idx < nx * ny; idx++, o += 4) {
    const t = near[idx]
      ? 1
      : Math.min(1, Math.log1p(B[idx] / b0) / norm);

    let s = 1;
    while (s < stops.length - 1 && stops[s][0] < t) s++;

    const lo = stops[s - 1];
    const hi = stops[s];
    const f = (t - lo[0]) / (hi[0] - lo[0] || 1);

    data[o] = lo[1] + (hi[1] - lo[1]) * f;
    data[o + 1] = lo[2] + (hi[2] - lo[2]) * f;
    data[o + 2] = lo[3] + (hi[3] - lo[3]) * f;
    data[o + 3] = 255 * alpha * (lo[4] + (hi[4] - lo[4]) * f);
  }

  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Filled isosceles arrowhead centred on (x, y), pointing along (ux, uy).
function sliceArrowhead(ctx, x, y, ux, uy, size) {
  const half = size * 0.46;
  const back = size * 0.5;
  const fwd = size * 0.6;
  const px = -uy;
  const py = ux;

  ctx.beginPath();
  ctx.moveTo(x + ux * fwd, y + uy * fwd);
  ctx.lineTo(x - ux * back + px * half, y - uy * back + py * half);
  ctx.lineTo(x - ux * back - px * half, y - uy * back - py * half);
  ctx.closePath();
  ctx.fill();
}

// A vector drawn as a shaft plus a filled isosceles head.
function sliceVector(ctx, x, y, vx, vy, color, width = 3) {
  const len = Math.hypot(vx, vy);
  if (len < 1.5) return;

  const ux = vx / len;
  const uy = vy / len;
  const head = Math.min(13, Math.max(7, len * 0.42));
  const shaft = Math.max(0, len - head * 0.8);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + ux * shaft, y + uy * shaft);
  ctx.stroke();

  const tx = x + ux * len;
  const ty = y + uy * len;
  const half = head * 0.5;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - ux * head - uy * half, ty - uy * head + ux * half);
  ctx.lineTo(tx - ux * head + uy * half, ty - uy * head - ux * half);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/*
 * Field layer: optional strength map underneath, contour field lines
 * and direction arrows on top. Returns the sampled grid.
 */
function drawSliceField(ctx, view, wires, opts) {
  const grid = sliceGrid(wires, view, opts.step, opts.cutoff);

  if (opts.strength) {
    const img = sliceStrengthCanvas(
      grid,
      opts.b0,
      opts.bmax,
      opts.strengthAlpha,
      opts.cache,
    );

    // Bilinear is plenty for a smooth colour field, and far cheaper
    // to rasterise than 'high' on every animation frame.
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.drawImage(
      img,
      -opts.step / 2,
      -opts.step / 2,
      grid.nx * opts.step,
      grid.ny * opts.step,
    );
    ctx.restore();
  }

  if (opts.lines) {
    const { segs, count, arrows } = sliceContours(
      grid,
      opts.spacing,
      opts.arrowCell,
    );

    // Contour pieces join end to end, so butt caps leave no gaps and
    // rasterise at half the cost of round ones.
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.strokeStyle = opts.lineColor;
    ctx.lineWidth = opts.lineWidth;
    ctx.beginPath();

    for (let k = 0; k < count * 4; k += 4) {
      ctx.moveTo(segs[k], segs[k + 1]);
      ctx.lineTo(segs[k + 2], segs[k + 3]);
    }

    ctx.stroke();

    ctx.fillStyle = opts.arrowColor;

    for (const [px, py] of sliceThin(arrows, opts.arrowMinDist)) {
      const [bx, by] = sliceFieldAt(
        wires,
        view.wx(px),
        view.wy(py),
      );
      const m = Math.hypot(bx, by);
      if (m < 1e-3) continue;

      // Screen y points down, so the field's y flips.
      sliceArrowhead(ctx, px, py, bx / m, -by / m, opts.arrowSize);
    }

    ctx.restore();
  }

  return grid;
}

/*
 * The wire as 3D polylines, split into runs behind the page, in it,
 * and in front of it, so each can be drawn in the right layer.
 */
function sliceCoilRuns(geo, view) {
  const pts = [];
  const xLeft = view.wx(-60);
  const xRight = view.wx(view.width + 60);

  // Lead in from the left, lying in the page along the top.
  pts.push([Math.min(xLeft, -1), SLICE_R, 0]);

  for (let i = 0; i < geo.base; i++) {
    const x0 = sliceTurnX(i);

    for (let k = 0; k <= 56; k++) {
      const phi = (k / 56) * Math.PI * 2;
      pts.push([
        phi <= Math.PI
          ? x0
          : x0 + (SLICE_PITCH * (phi - Math.PI)) / Math.PI,
        SLICE_R * Math.cos(phi),
        SLICE_R * Math.sin(phi),
      ]);
    }
  }

  if (geo.E != null) {
    for (let k = 0; k <= 180; k++) {
      const p = sliceFormingPoint(
        geo.base,
        (k / 180) * SLICE_TURN_LENGTH,
        geo.E,
      );
      pts.push([p[0], p[1], p[2]]);
    }

    // The unwound tail trails off parallel to the axis.
    const end = pts[pts.length - 1];
    pts.push([Math.max(xRight, end[0] + 1), end[1], end[2]]);
  } else {
    const x = sliceTurnX(geo.base);
    pts.push([x, SLICE_R, 0]);
    pts.push([Math.max(xRight, x + 1), SLICE_R, 0]);
  }

  const runs = { back: [], plane: [], front: [] };
  let run = null;
  let kind = null;

  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    const zm = (a[2] + b[2]) / 2;
    const kk = zm > 0.01 ? 'front' : zm < -0.01 ? 'back' : 'plane';

    if (kk !== kind) {
      run = [view.project(a)];
      runs[kk].push(run);
      kind = kk;
    }

    run.push(view.project(b));
  }

  return runs;
}

function strokeRuns(ctx, runs) {
  for (const run of runs) {
    if (run.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(run[0][0], run[0][1]);
    for (let k = 1; k < run.length; k++) {
      ctx.lineTo(run[k][0], run[k][1]);
    }
    ctx.stroke();
  }
}

// A turn's front half reads as a solid metal bar passing in front.
function drawFrontRuns(ctx, runs, width) {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.strokeStyle = 'rgba(8, 12, 18, 0.9)';
  ctx.lineWidth = width + 3;
  strokeRuns(ctx, runs);

  ctx.strokeStyle = 'rgba(132, 146, 160, 0.9)';
  ctx.lineWidth = width;
  strokeRuns(ctx, runs);

  ctx.translate(-width * 0.16, -width * 0.12);
  ctx.strokeStyle = 'rgba(226, 236, 244, 0.42)';
  ctx.lineWidth = width * 0.26;
  strokeRuns(ctx, runs);
  ctx.restore();
}

function drawCrossingMarker(ctx, x, y, r, I, alpha) {
  if (alpha <= 0.01) return;

  ctx.save();
  ctx.globalAlpha = alpha;

  const g = ctx.createRadialGradient(
    x - r * 0.35,
    y - r * 0.35,
    r * 0.1,
    x,
    y,
    r,
  );
  g.addColorStop(0, '#f4f7fa');
  g.addColorStop(1, '#a9b5c1');

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(10, 14, 20, 0.95)';
  ctx.stroke();

  ctx.fillStyle = SLICE_CURRENT_COLOR;
  ctx.strokeStyle = SLICE_CURRENT_COLOR;

  if (I > 0) {
    // ⊙ current out of the page
    ctx.beginPath();
    ctx.arc(x, y, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // ⊗ current into the page
    const c = r * 0.48;
    ctx.lineWidth = Math.max(1.6, r * 0.2);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - c, y - c);
    ctx.lineTo(x + c, y + c);
    ctx.moveTo(x + c, y - c);
    ctx.lineTo(x - c, y + c);
    ctx.stroke();
  }

  ctx.restore();
}

function drawSelectionRing(ctx, x, y, r, color, label, below) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(x, y, r + 5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (label) {
    const ly = below ? y + r + 17 : y - r - 17;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, ly, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#10141c';
    ctx.font = '800 11px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, ly + 0.5);
  }

  ctx.restore();
}

function drawPoleLabel(ctx, x, y, letter) {
  const color = letter === 'N' ? '#ff2231' : '#1f6bff';

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.fillStyle = '#0b1018';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = '800 14px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, x, y + 0.5);
  ctx.restore();
}

function drawProbe(ctx, x, y, vectors, scale) {
  if (vectors) {
    const [a, b] = vectors;
    const sum = [a[0] + b[0], a[1] + b[1]];

    sliceVector(ctx, x, y, a[0] * scale, -a[1] * scale, SLICE_A_COLOR, 2.5);
    sliceVector(ctx, x, y, b[0] * scale, -b[1] * scale, SLICE_B_COLOR, 2.5);
    sliceVector(ctx, x, y, sum[0] * scale, -sum[1] * scale, '#ffffff', 3);
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(5, 8, 13, 0.55)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
}

// Readout of the two selected crossings' fields at the probe.
function sliceReadout(a, b, probe, coilWires) {
  if (!a || !b || !probe) return null;

  const fa = sliceFieldAt([a], probe[0], probe[1]);
  const fb = sliceFieldAt([b], probe[0], probe[1]);
  const sum = [fa[0] + fb[0], fa[1] + fb[1]];
  const coil = sliceFieldAt(coilWires, probe[0], probe[1]);

  const ma = Math.hypot(...fa);
  const mb = Math.hypot(...fb);
  const ms = Math.hypot(...sum);
  const mc = Math.hypot(...coil);

  const agreement = ma + mb > 1e-9 ? ms / (ma + mb) : 0;
  const cos =
    ma > 1e-9 && mb > 1e-9
      ? (fa[0] * fb[0] + fa[1] * fb[1]) / (ma * mb)
      : 1;
  const angle = (Math.acos(sliceClamp(cos, -1, 1)) * 180) / Math.PI;

  return { fa, fb, sum, ma, mb, ms, mc, agreement, angle };
}

function sliceRelation(a, b) {
  const gap = Math.abs(a.turn - b.turn);
  const sameSide = a.side === b.side;

  const where = sameSide
    ? gap === 1
      ? 'Neighbouring turns, same side'
      : `Same side, ${gap} turns apart`
    : gap === 0
      ? 'Opposite sides of one turn'
      : `Opposite sides, ${gap} turn${gap === 1 ? '' : 's'} apart`;

  const current = sameSide
    ? 'current flows the same way through both'
    : 'current flows opposite ways';

  return { where, current, sameSide };
}

function SliceView({ switcher, active }) {
  const stageRef = useRef(null);
  const canvasRef = useRef(null);
  const compareRef = useRef(null);
  const miniRefs = useRef([]);

  const [turns, setTurns] = useState(SLICE_START_TURNS);
  const [animating, setAnimating] = useState(false);
  const [reversed, setReversed] = useState(false);
  const [showTurns, setShowTurns] = useState(true);
  const [source, setSource] = useState('coil');
  const [display, setDisplay] = useState('both');
  const [density, setDensity] = useState(12);
  const [selection, setSelection] = useState({ a: null, b: null });
  const [probe, setProbe] = useState(null);
  const [miniTick, setMiniTick] = useState(0);
  // Pulse the progress bar when this screen first opens, until used.
  const [barAttention, setBarAttention] = useState(true);

  const dir = reversed ? -1 : 1;
  const spacing = 9 / density;

  const live = useRef({});
  live.current = {
    reversed,
    dir,
    showTurns,
    source,
    display,
    spacing,
    selection,
    probe,
    active,
  };

  const progressFillRef = useRef(null);

  const sim = useRef({
    turns: SLICE_START_TURNS,
    // Turn count being worked towards; turns wrap one at a time.
    target: SLICE_START_TURNS,
    fast: false,
    anim: null,
    dirty: true,
    view: null,
    hover: null,
    drag: null,
    down: null,
    cache: {},
  });

  const crossA = sliceCrossingFromId(selection.a, dir);
  const crossB = sliceCrossingFromId(selection.b, dir);
  const pairReady = Boolean(crossA && crossB);

  const coilWires = sliceCrossings({ base: turns, E: null }, dir);
  const readout = sliceReadout(crossA, crossB, probe, coilWires);
  const relation = pairReady ? sliceRelation(crossA, crossB) : null;

  // Move the probe to the pair's midpoint whenever the pair changes.
  useEffect(() => {
    if (selection.a && selection.b) {
      const a = sliceCrossingFromId(selection.a, 1);
      const b = sliceCrossingFromId(selection.b, 1);
      setProbe([(a.x + b.x) / 2, (a.y + b.y) / 2]);
    } else {
      setProbe(null);
    }
  }, [selection.a, selection.b]);

  useEffect(() => {
    if (!selection.a && !selection.b && source === 'pair') {
      setSource('coil');
    }
  }, [selection.a, selection.b, source]);

  useEffect(() => {
    sim.current.dirty = true;
  }, [
    turns,
    reversed,
    showTurns,
    source,
    display,
    density,
    selection,
    probe,
    active,
  ]);

  // Main canvas: animation loop, drawing and pointer input.
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const S = sim.current;

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

    function resize() {
      const rect = stage.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (!w || !h) return;

      width = w;
      height = h;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);

      // Resizing clears the canvas, so repaint now rather than leave
      // a blank frame until the next tick.
      if (live.current.active) {
        draw(currentGeo(performance.now()));
        S.dirty = false;
      } else {
        S.dirty = true;
      }
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);
    resize();

    function currentGeo(now) {
      if (!S.anim) return { base: S.turns, E: null };

      const t = sliceClamp(
        (now - S.anim.start) / S.anim.duration,
        0,
        1,
      );
      const e = sliceEase(t);

      return {
        base: S.anim.base,
        E: S.anim.kind === 'wrap' ? e : 1 - e,
        done: t >= 1,
      };
    }

    function draw(geo) {
      const L = live.current;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = SLICE_BG;
      ctx.fillRect(0, 0, width, height);

      /*
       * Frame the coil as it is now, so a narrow screen is not zoomed
       * out for ten turns it may never have. span follows the forming
       * turn, so the framing eases out as each turn wraps. Wide screens
       * are limited by height and never change scale.
       */
      const span = geo.base - 1 + (geo.E ?? 0);
      const worldW =
        Math.max(span + 1, 3) * SLICE_PITCH + SLICE_WORLD_MARGIN;
      const scale = Math.min(
        width / worldW,
        height / SLICE_WORLD_H,
      );

      // Keep the wound coil centred, sliding as a turn forms.
      const view = sliceView(
        width,
        height,
        (Math.max(span, 0) / 2) * SLICE_PITCH,
        0,
        scale,
      );
      S.view = view;

      // The progress bar fills continuously through each turn.
      if (progressFillRef.current) {
        progressFillRef.current.style.width = `${
          ((geo.base + (geo.E ?? 0)) / SLICE_MAX_TURNS) * 100
        }%`;
      }

      const wires = sliceCrossings(geo, L.dir);
      const a = sliceCrossingFromId(L.selection.a, L.dir);
      const b = sliceCrossingFromId(L.selection.b, L.dir);
      const pair = [a, b].filter(Boolean);
      const pairMode = L.source === 'pair' && pair.length > 0;
      const fieldWires = pairMode ? pair : wires;

      const markerR = Math.max(7, SLICE_WIRE_R * scale);
      const runs = sliceCoilRuns(geo, view);

      if (L.showTurns) {
        ctx.save();
        ctx.setLineDash([5, 6]);
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(150, 168, 186, 0.3)';
        ctx.lineWidth = Math.max(1.5, markerR * 0.32);
        strokeRuns(ctx, runs.back);
        ctx.restore();
      }

      const showLines = L.display !== 'strength';
      const showStrength = L.display !== 'lines';

      drawSliceField(ctx, view, fieldWires, {
        step: 4,
        cutoff: (markerR * 1.05) / scale,
        spacing: L.spacing,
        lines: showLines,
        strength: showStrength,
        strengthAlpha: showLines ? 0.62 : 1,
        b0: 0.5,
        bmax: 14,
        lineColor: pairMode
          ? 'rgba(232, 236, 255, 0.82)'
          : 'rgba(118, 208, 255, 0.85)',
        arrowColor: pairMode ? '#f2f4ff' : '#9fe3ff',
        lineWidth: 1.25,
        arrowCell: 84,
        arrowMinDist: 36,
        arrowSize: 9,
        cache: S.cache,
      });

      /*
       * The unwound wire lying in the page (its own field has no
       * in-page part). It fades out to either side so it reads as the
       * supply of wire still to wrap, not as part of the picture.
       */
      const coilLeft = sliceTurnX(0);
      const coilRight = sliceTurnX(geo.base + (geo.E ?? 0));
      const fade = ctx.createLinearGradient(
        view.sx(coilLeft - 2.2),
        0,
        view.sx(coilRight + 7),
        0,
      );
      const total = coilRight + 7 - (coilLeft - 2.2);
      const near0 = 2 / total;
      const near1 = (coilRight + 0.2 - (coilLeft - 2.2)) / total;

      fade.addColorStop(0, 'rgba(176, 190, 204, 0)');
      fade.addColorStop(sliceClamp(near0, 0, 1), 'rgba(176, 190, 204, 0.5)');
      fade.addColorStop(sliceClamp(near1, 0, 1), 'rgba(176, 190, 204, 0.5)');
      fade.addColorStop(1, 'rgba(176, 190, 204, 0)');

      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = fade;
      ctx.lineWidth = Math.max(2, markerR * 0.42);
      strokeRuns(ctx, runs.plane);
      ctx.restore();

      if (L.showTurns) {
        drawFrontRuns(ctx, runs.front, markerR * 1.3);

        // Current direction on the front of each finished turn.
        ctx.save();
        ctx.fillStyle = SLICE_CURRENT_COLOR;
        for (let i = 0; i < geo.base; i++) {
          const [x, y] = view.project([sliceTurnX(i), 0, SLICE_R]);
          sliceArrowhead(ctx, x, y, 0, L.dir, 11);
        }
        ctx.restore();
      }

      const selectedIds = new Set(pair.map((p) => p.id));

      for (const w of wires) {
        const ghost = pairMode && !selectedIds.has(w.id);
        drawCrossingMarker(
          ctx,
          view.sx(w.x),
          view.sy(w.y),
          markerR,
          w.I,
          w.w * (ghost ? 0.3 : 1),
        );
      }

      if (S.hover && !selectedIds.has(S.hover)) {
        const h = sliceCrossingFromId(S.hover, L.dir);
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(view.sx(h.x), view.sy(h.y), markerR + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (a) {
        drawSelectionRing(
          ctx,
          view.sx(a.x),
          view.sy(a.y),
          markerR,
          SLICE_A_COLOR,
          'A',
          a.side === 'bottom',
        );
      }

      if (b) {
        drawSelectionRing(
          ctx,
          view.sx(b.x),
          view.sy(b.y),
          markerR,
          SLICE_B_COLOR,
          'B',
          b.side === 'bottom',
        );
      }

      // Poles once there is enough coil to have them.
      const ends = geo.base + (geo.E ?? 0);
      if (ends >= 2) {
        const left = view.sx(sliceTurnX(0) - 0.78);
        const right = view.sx(sliceTurnX(ends - 1) + 0.78);
        const cy = view.sy(0);
        drawPoleLabel(ctx, right, cy, L.dir > 0 ? 'N' : 'S');
        drawPoleLabel(ctx, left, cy, L.dir > 0 ? 'S' : 'N');
      }

      if (a && b && L.probe) {
        const fa = sliceFieldAt([a], L.probe[0], L.probe[1]);
        const fb = sliceFieldAt([b], L.probe[0], L.probe[1]);
        const biggest = Math.max(
          Math.hypot(...fa),
          Math.hypot(...fb),
          1e-6,
        );

        drawProbe(
          ctx,
          view.sx(L.probe[0]),
          view.sy(L.probe[1]),
          [fa, fb],
          Math.min(46 / biggest, 60),
        );
      }
    }

    function frame() {
      raf = requestAnimationFrame(frame);

      if (!live.current.active || !width || !height) return;

      // Same clock as the animation's start time.
      const geo = currentGeo(performance.now());

      if (S.anim) {
        S.dirty = true;

        if (geo.done) {
          const kind = S.anim.kind;
          S.anim = null;
          S.turns += kind === 'wrap' ? 1 : -1;
          setTurns(S.turns);

          // Carry on towards the target, or come to rest.
          if (!S.next()) {
            S.fast = false;
            setAnimating(false);
          }

          draw(currentGeo(performance.now()));
          S.dirty = false;
          return;
        }
      }

      if (!S.dirty) return;
      S.dirty = false;
      draw(geo);
    }

    raf = requestAnimationFrame(frame);

    function toLocal(event) {
      const rect = canvas.getBoundingClientRect();
      return [event.clientX - rect.left, event.clientY - rect.top];
    }

    function crossingAt(px, py) {
      const view = S.view;
      if (!view) return null;

      const base = S.anim ? S.anim.base : S.turns;
      const reach = Math.max(14, SLICE_WIRE_R * view.scale + 6);
      let best = null;
      let bestD = reach;

      for (let i = 0; i < base; i++) {
        for (const id of [`t${i}`, `b${i}`]) {
          const c = sliceCrossingFromId(id, 1);
          const d = Math.hypot(view.sx(c.x) - px, view.sy(c.y) - py);
          if (d < bestD) {
            bestD = d;
            best = id;
          }
        }
      }

      return best;
    }

    function overProbe(px, py) {
      const p = live.current.probe;
      const view = S.view;
      if (!p || !view) return false;
      return Math.hypot(view.sx(p[0]) - px, view.sy(p[1]) - py) < 16;
    }

    function onPointerDown(event) {
      const [px, py] = toLocal(event);

      if (overProbe(px, py)) {
        S.drag = { id: event.pointerId };
        canvas.setPointerCapture(event.pointerId);
        canvas.style.cursor = 'grabbing';
        return;
      }

      S.down = { x: px, y: py };
    }

    function onPointerMove(event) {
      const [px, py] = toLocal(event);

      if (S.drag) {
        const view = S.view;
        setProbe([view.wx(px), view.wy(py)]);
        return;
      }

      const hit = crossingAt(px, py);
      if (hit !== S.hover) {
        S.hover = hit;
        S.dirty = true;
      }

      canvas.style.cursor = overProbe(px, py)
        ? 'grab'
        : hit
          ? 'pointer'
          : 'default';
    }

    function onPointerUp(event) {
      const [px, py] = toLocal(event);

      if (S.drag) {
        S.drag = null;
        canvas.releasePointerCapture(event.pointerId);
        canvas.style.cursor = 'grab';
        return;
      }

      const down = S.down;
      S.down = null;
      if (!down || Math.hypot(px - down.x, py - down.y) > 6) return;

      const id = crossingAt(px, py);
      if (!id) return;

      setSelection((prev) => {
        let { a, b } = prev;
        if (a === id) a = null;
        else if (b === id) b = null;
        else if (!a) a = id;
        else b = id;
        return { a, b };
      });
    }

    function onPointerLeave() {
      if (S.hover) {
        S.hover = null;
        S.dirty = true;
      }
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);

    // Start wrapping or unwrapping the next turn towards S.target.
    S.next = () => {
      if (S.anim || S.target === S.turns) return false;

      const kind = S.target > S.turns ? 'wrap' : 'unwrap';

      S.anim = {
        kind,
        base: kind === 'wrap' ? S.turns : S.turns - 1,
        start: performance.now(),
        duration: S.fast ? SLICE_JUMP_MS : SLICE_WRAP_MS,
      };
      S.dirty = true;
      return true;
    };

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerLeave);
    };
  }, []);

  // Redraw the comparison panels when their size changes.
  useEffect(() => {
    const host = compareRef.current;
    if (!host) return undefined;

    const resizeObserver = new ResizeObserver(() =>
      setMiniTick((t) => t + 1),
    );
    resizeObserver.observe(host);
    return () => resizeObserver.disconnect();
  }, []);

  // Comparison panels: A alone, B alone, A + B.
  useEffect(() => {
    if (!active) return;

    const a = sliceCrossingFromId(selection.a, dir);
    const b = sliceCrossingFromId(selection.b, dir);
    const ghosts = sliceCrossings({ base: turns, E: null }, dir);

    const panels = [
      { wires: a ? [a] : [], color: 'rgba(255, 181, 71, 0.85)', arrow: SLICE_A_COLOR },
      { wires: b ? [b] : [], color: 'rgba(255, 95, 168, 0.85)', arrow: SLICE_B_COLOR },
      { wires: [a, b].filter(Boolean), color: 'rgba(240, 244, 255, 0.85)', arrow: '#ffffff' },
    ];

    // One crop for all three so they compare like for like.
    const anchor = [a, b].filter(Boolean);
    const pts = anchor.map((c) => [c.x, c.y]);
    if (probe) pts.push(probe);

    let minX = -1.2;
    let maxX = 1.2;
    let minY = -1.2;
    let maxY = 1.2;

    if (pts.length) {
      minX = Math.min(...pts.map((p) => p[0])) - 0.8;
      maxX = Math.max(...pts.map((p) => p[0])) + 0.8;
      minY = Math.min(...pts.map((p) => p[1])) - 0.8;
      maxY = Math.max(...pts.map((p) => p[1])) + 0.8;
    }

    const fa = a && probe ? sliceFieldAt([a], probe[0], probe[1]) : null;
    const fb = b && probe ? sliceFieldAt([b], probe[0], probe[1]) : null;

    panels.forEach((panel, k) => {
      const canvas = miniRefs.current[k];
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (!w || !h) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);

      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#060a10';
      ctx.fillRect(0, 0, w, h);

      if (!anchor.length) return;

      const scale = Math.min(w / (maxX - minX), h / (maxY - minY));
      const view = sliceView(
        w,
        h,
        (minX + maxX) / 2,
        (minY + maxY) / 2,
        scale,
      );
      const markerR = Math.max(6, SLICE_WIRE_R * scale);

      if (panel.wires.length) {
        drawSliceField(ctx, view, panel.wires, {
          step: 3,
          cutoff: (markerR * 1.05) / scale,
          spacing: spacing * 0.55,
          lines: display !== 'strength',
          strength: display !== 'lines',
          strengthAlpha: display === 'strength' ? 1 : 0.6,
          b0: 0.35,
          bmax: 7,
          lineColor: panel.color,
          arrowColor: panel.arrow,
          lineWidth: 1.1,
          arrowCell: 60,
          arrowMinDist: 26,
          arrowSize: 7,
          cache: {},
        });
      }

      // The rest of the coil, faintly, for context.
      for (const g of ghosts) {
        if (g.id === selection.a || g.id === selection.b) continue;
        drawCrossingMarker(ctx, view.sx(g.x), view.sy(g.y), markerR * 0.85, g.I, 0.16);
      }

      for (const c of anchor) {
        const on = panel.wires.includes(c);
        drawCrossingMarker(ctx, view.sx(c.x), view.sy(c.y), markerR, c.I, on ? 1 : 0.28);
        if (on) {
          drawSelectionRing(
            ctx,
            view.sx(c.x),
            view.sy(c.y),
            markerR,
            c === a ? SLICE_A_COLOR : SLICE_B_COLOR,
            null,
            false,
          );
        }
      }

      if (probe && fa && fb) {
        const biggest = Math.max(Math.hypot(...fa), Math.hypot(...fb), 1e-6);
        const unit = (Math.min(w, h) * 0.24) / biggest;
        const px = view.sx(probe[0]);
        const py = view.sy(probe[1]);

        if (k === 0) {
          sliceVector(ctx, px, py, fa[0] * unit, -fa[1] * unit, SLICE_A_COLOR, 3);
        } else if (k === 1) {
          sliceVector(ctx, px, py, fb[0] * unit, -fb[1] * unit, SLICE_B_COLOR, 3);
        } else {
          // Tip to tail: A, then B from A's tip, then the sum.
          const ax = fa[0] * unit;
          const ay = -fa[1] * unit;
          sliceVector(ctx, px, py, ax, ay, SLICE_A_COLOR, 2.5);
          sliceVector(ctx, px + ax, py + ay, fb[0] * unit, -fb[1] * unit, SLICE_B_COLOR, 2.5);
          sliceVector(
            ctx,
            px,
            py,
            (fa[0] + fb[0]) * unit,
            -(fa[1] + fb[1]) * unit,
            '#ffffff',
            3.5,
          );
        }

        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }
    });
  }, [active, selection.a, selection.b, probe, dir, turns, spacing, display, miniTick]);

  /*
   * Head for a turn count. Turns always wrap one at a time; a jump of
   * more than one turn plays each quickly. Crossings on turns that are
   * going away are deselected straight away.
   */
  function requestTurns(target) {
    const S = sim.current;
    const goal = sliceClamp(Math.round(target), 0, SLICE_MAX_TURNS);

    if (goal === S.target) return;

    S.fast = Boolean(S.anim) || Math.abs(goal - S.turns) > 1;
    S.target = goal;

    const keep = (id) =>
      id && Number(id.slice(1)) >= goal ? null : id;
    setSelection((prev) => ({ a: keep(prev.a), b: keep(prev.b) }));

    if (S.next?.()) setAnimating(true);
  }

  function handleWrap() {
    requestTurns(turns + 1);
  }

  function handleUnwrap() {
    requestTurns(turns - 1);
  }

  function turnsAtPointer(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const f = (event.clientX - rect.left) / rect.width;
    return sliceClamp(f, 0, 1) * SLICE_MAX_TURNS;
  }

  function handleProgressKey(event) {
    const step = {
      ArrowRight: 1,
      ArrowUp: 1,
      ArrowLeft: -1,
      ArrowDown: -1,
    }[event.key];

    if (!step) return;
    event.preventDefault();
    requestTurns(sim.current.target + step);
  }

  function pickNeighbours() {
    if (turns < 2) return;
    const i = Math.max(0, Math.floor((turns - 2) / 2));
    setSelection({ a: `t${i}`, b: `t${i + 1}` });
  }

  function pickOpposite() {
    if (turns < 1) return;
    const i = Math.floor((turns - 1) / 2);
    setSelection({ a: `t${i}`, b: `b${i}` });
  }

  const verdict = readout
    ? readout.agreement < 0.35
      ? 'cancel'
      : readout.agreement > 0.8
        ? 'add'
        : 'partial'
    : null;

  const verdictLabel = {
    cancel: 'They cancel',
    add: 'They add',
    partial: 'Partly',
  }[verdict];

  let explanation = '';
  if (readout) {
    if (readout.agreement < 0.2) {
      explanation =
        'At the probe their fields point opposite ways, so they cancel almost completely.';
    } else if (readout.agreement < 0.6) {
      explanation =
        'At the probe their fields mostly oppose each other, so they partly cancel.';
    } else if (readout.agreement < 0.97) {
      explanation = `At the probe their fields are ${Math.round(
        readout.angle,
      )}° apart, so they ${
        readout.agreement > 0.8 ? 'mostly' : 'partly'
      } add.`;
    } else {
      explanation =
        'At the probe their fields point the same way, so they add.';
    }
  }

  const barMax = readout
    ? Math.max(readout.ma + readout.mb, readout.mc, 1e-6)
    : 1;

  const bars = readout
    ? [
        { label: 'A alone', value: readout.ma, cls: 'bar-a' },
        { label: 'B alone', value: readout.mb, cls: 'bar-b' },
        { label: 'A + B', value: readout.ms, cls: 'bar-sum' },
        {
          label: `Whole coil`,
          value: readout.mc,
          cls: 'bar-coil',
        },
      ]
    : [];

  const miniLabels = ['A alone', 'B alone', 'A + B'];

  return (
    <div className="magnetic-app">
      <style>{`
        .slice-panel {
          display: grid;
          grid-template-rows: auto minmax(0, 1fr) auto auto;
        }

        .slice-progress {
          padding: 2px 22px 12px;
          background: rgba(3, 8, 14, 0.66);
        }

        .slice-progress .progress-hit {
          outline: none;
        }

        .slice-progress .progress-hit:focus-visible .progress-bar {
          border-color: rgba(98, 230, 255, 0.6);
        }

        /* The draw loop moves the fill every frame, so no easing. */
        .slice-fill {
          transition: none;
        }

        /* One tick per turn. */
        .slice-bar::after {
          content: '';
          position: absolute;
          inset: 0;
          background: repeating-linear-gradient(
            90deg,
            transparent 0,
            transparent calc(10% - 1px),
            rgba(5, 8, 13, 0.9) calc(10% - 1px),
            rgba(5, 8, 13, 0.9) 10%
          );
          pointer-events: none;
        }

        .slice-top {
          position: relative;
          z-index: 2;
          display: grid;
          grid-template-columns: minmax(300px, 1fr) auto;
          grid-template-areas:
            "title controls"
            "help  controls";
          grid-template-rows: auto 1fr;
          column-gap: 24px;
          row-gap: 12px;
          align-items: start;
          padding: 20px 20px 8px 22px;
        }

        .slice-top .top-controls {
          gap: 8px;
        }

        .slice-sub {
          margin: 8px 0 0;
          color: #8fb1c1;
          font-size: 12.5px;
          line-height: 1.4;
        }

        .slice-slider {
          grid-template-columns: 200px;
          padding: 9px 14px 10px;
        }

        .segment:disabled {
          opacity: 0.35;
          cursor: default;
        }

        .slice-toggle {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 9px 12px;
          border: 1px solid rgba(147, 212, 240, 0.22);
          border-radius: 12px;
          background: rgba(8, 20, 30, 0.78);
          color: #d6ebf5;
          font-size: 12px;
          font-weight: 800;
          white-space: nowrap;
          cursor: pointer;
        }

        .slice-toggle input {
          accent-color: #47c8ff;
          width: 15px;
          height: 15px;
          margin: 0;
        }

        .slice-stage {
          position: relative;
          min-height: 0;
          overflow: hidden;
        }

        .slice-stage canvas {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          display: block;
          touch-action: none;
        }

        .slice-legend {
          position: absolute;
          left: 22px;
          bottom: 12px;
          display: flex;
          flex-wrap: wrap;
          gap: 6px 14px;
          padding: 8px 11px;
          border-radius: 11px;
          background: rgba(5, 12, 20, 0.9);
          border: 1px solid rgba(160, 218, 240, 0.12);
          color: #9fbccb;
          font-size: 11px;
          pointer-events: none;
        }

        .slice-legend span {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          white-space: nowrap;
        }

        .slice-legend .sym {
          color: #ff4a5a;
          font-size: 14px;
          line-height: 1;
        }

        .slice-legend .swatch-line {
          width: 18px;
          height: 2px;
          border-radius: 2px;
          background: #76d0ff;
        }

        .slice-legend .swatch-heat {
          width: 26px;
          height: 8px;
          border-radius: 4px;
          background: linear-gradient(90deg, #0a224e, #1060a4, #46bae8, #daf7ff);
        }

        .slice-compare {
          display: grid;
          grid-template-columns:
            repeat(3, minmax(0, 1fr))
            minmax(280px, 1.25fr);
          grid-template-rows: auto auto;
          gap: 10px 12px;
          padding: 12px 20px 8px 22px;
          border-top: 1px solid rgba(145, 211, 239, 0.12);
          background: rgba(3, 8, 14, 0.66);
        }

        .compare-head {
          grid-column: 1 / -1;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: space-between;
          gap: 8px 16px;
        }

        .compare-title {
          display: flex;
          flex: 1 1 0;
          align-items: baseline;
          gap: 10px;
          min-width: 0;
          overflow: hidden;
        }

        .compare-title > span {
          white-space: nowrap;
        }

        .compare-current {
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .compare-kicker {
          font-size: 11px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: #7fc5e5;
          font-weight: 750;
        }

        .compare-where {
          color: #eaf8ff;
          font-size: 13px;
          font-weight: 750;
        }

        .compare-current {
          color: #8fb1c1;
          font-size: 12px;
        }

        /*
         * Panels and verdict share one fixed height so the strip never
         * changes size with its content, which would resize the slice.
         */
        .mini {
          position: relative;
          height: 176px;
          border-radius: 12px;
          border: 1px solid rgba(160, 218, 240, 0.12);
          overflow: hidden;
          background: #060a10;
        }

        .mini canvas {
          display: block;
          width: 100%;
          height: 100%;
        }

        .mini-chip {
          position: absolute;
          left: 8px;
          top: 8px;
          padding: 3px 8px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 800;
          background: rgba(5, 10, 16, 0.82);
          border: 1px solid currentColor;
        }

        .mini-chip.chip-0 { color: ${SLICE_A_COLOR}; }
        .mini-chip.chip-1 { color: ${SLICE_B_COLOR}; }
        .mini-chip.chip-2 { color: #ffffff; }

        .mini-empty {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 16px;
          color: #5f7d8c;
          font-size: 12px;
          text-align: center;
        }

        .verdict {
          display: flex;
          flex-direction: column;
          gap: 10px;
          height: 176px;
          overflow: auto;
          min-width: 0;
          padding: 12px 14px;
          border-radius: 12px;
          border: 1px solid rgba(160, 218, 240, 0.12);
          background: rgba(5, 14, 22, 0.78);
        }

        .verdict-badge {
          display: inline-block;
          margin-right: 8px;
          padding: 2px 9px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 850;
          letter-spacing: 0.02em;
        }

        .verdict-badge.cancel {
          color: #ffd9a8;
          background: rgba(120, 70, 10, 0.35);
          border: 1px solid rgba(255, 181, 71, 0.45);
        }

        .verdict-badge.add {
          color: #c9f6ff;
          background: rgba(20, 110, 150, 0.35);
          border: 1px solid rgba(98, 230, 255, 0.5);
        }

        .verdict-badge.partial {
          color: #e6dcff;
          background: rgba(70, 60, 120, 0.3);
          border: 1px solid rgba(180, 170, 255, 0.4);
        }

        .verdict-text {
          margin: 0;
          color: #b7cfdb;
          font-size: 12px;
          line-height: 1.45;
        }

        .bars {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          align-items: center;
          gap: 5px 9px;
          font-size: 11px;
          color: #9fbccb;
        }

        .bar-track {
          display: block;
          height: 7px;
          border-radius: 999px;
          background: rgba(127, 197, 229, 0.09);
          overflow: hidden;
        }

        .bar-fill {
          height: 100%;
          border-radius: inherit;
          transition: width .2s ease;
        }

        .bar-a .bar-fill { background: ${SLICE_A_COLOR}; }
        .bar-b .bar-fill { background: ${SLICE_B_COLOR}; }
        .bar-sum .bar-fill { background: #ffffff; }
        .bar-coil .bar-fill { background: linear-gradient(90deg, #47c8ff, #8a8dff); }

        .bar-value {
          color: #dcefff;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          text-align: right;
        }

        .verdict-empty {
          color: #9fbccb;
          font-size: 12px;
          line-height: 1.5;
        }

        @media (max-width: 940px) {
          .slice-compare {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }

          .verdict {
            grid-column: 1 / -1;
            height: 140px;
          }

          .mini {
            height: 140px;
          }
        }

        @media (max-width: 820px) {
          .slice-panel {
            height: auto;
            min-height: 100vh;
            overflow: visible;
          }

          .slice-top {
            grid-template-columns: minmax(0, 1fr);
            grid-template-areas:
              "title"
              "controls"
              "help";
            padding: 16px 16px 8px 18px;
          }

          .slice-top .top-controls {
            justify-self: stretch;
            align-items: flex-start;
          }

          .slice-top .toolbar {
            justify-content: flex-start;
          }

          .slice-stage {
            height: 58vh;
            min-height: 320px;
          }

          .slice-compare {
            padding: 12px 16px 8px;
          }

          .slice-progress {
            padding: 2px 16px 14px;
          }

          .slice-legend {
            left: 12px;
            right: 12px;
          }

          .verdict {
            height: auto;
          }
        }

        @media (max-width: 520px) {
          .slice-compare {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 8px;
          }

          .compare-title {
            flex-basis: 100%;
            flex-wrap: wrap;
            row-gap: 2px;
          }

          .compare-title > span {
            white-space: normal;
          }

          .mini {
            height: 110px;
          }

          .mini-chip {
            font-size: 10px;
            padding: 2px 6px;
          }
        }
      `}</style>

      <div className="magnetic-panel slice-panel">
        <header className="slice-top">
          <div className="top-title">
            <div className="kicker">
              Magnetism · Cross-section
            </div>

            <h1 className="title">
              Slice through the solenoid
            </h1>

            <p className="slice-sub">
              Each turn pierces the page twice. Click two crossings
              to compare their fields.
            </p>
          </div>

          <div className="top-controls">
            <div className="toolbar">
              <div
                className="toolbar-group"
                role="group"
                aria-label="Overlays"
              >
                <button
                  type="button"
                  className="current-toggle reverse-button"
                  onClick={() => setReversed((r) => !r)}
                  title="Reverse the current, flipping every field and swapping the poles"
                >
                  <span className="reverse-icon" aria-hidden="true">⇄</span>
                  <span>Reverse current</span>
                </button>

                <label className="slice-toggle">
                  <input
                    type="checkbox"
                    checked={showTurns}
                    onChange={(e) => setShowTurns(e.target.checked)}
                  />
                  <span>Show turns</span>
                </label>
              </div>
            </div>

            <div className="toolbar">
              <div
                className="segmented"
                role="group"
                aria-label="Field source"
              >
                <button
                  className={`segment ${source === 'coil' ? 'active' : ''}`}
                  aria-pressed={source === 'coil'}
                  onClick={() => setSource('coil')}
                >
                  Whole coil
                </button>

                <button
                  className={`segment ${source === 'pair' ? 'active' : ''}`}
                  aria-pressed={source === 'pair'}
                  onClick={() => setSource('pair')}
                  disabled={!selection.a && !selection.b}
                  title={
                    !selection.a && !selection.b
                      ? 'Select a crossing first'
                      : undefined
                  }
                >
                  Selected only
                </button>
              </div>

              <div
                className="segmented"
                role="group"
                aria-label="Field display"
              >
                {[
                  ['lines', 'Lines'],
                  ['strength', 'Strength'],
                  ['both', 'Both'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    className={`segment ${display === key ? 'active' : ''}`}
                    aria-pressed={display === key}
                    onClick={() => setDisplay(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="slider-panel slice-slider">
              <SliderField
                label="Line density"
                valueText={density}
                value={density}
                min={6}
                max={24}
                step={1}
                onChange={(e) => setDensity(Number(e.target.value))}
                disabled={display === 'strength'}
                disabledHint="Only used when field lines are shown"
              />
            </div>
          </div>
        </header>

        <div ref={stageRef} className="slice-stage">
          <canvas
            ref={canvasRef}
            aria-label="Cross-section of the solenoid with its magnetic field"
          />

          <div className="slice-legend" aria-hidden="true">
            <span>
              <i className="sym">⊙</i> out of page
            </span>
            <span>
              <i className="sym">⊗</i> into page
            </span>
            {display !== 'strength' && (
              <span>
                <i className="swatch-line" /> field line · closer = stronger
              </span>
            )}
            {display !== 'lines' && (
              <span>
                <i className="swatch-heat" /> field strength
              </span>
            )}
          </div>
        </div>

        <section
          ref={compareRef}
          className="slice-compare"
          aria-label="Compare two crossings"
        >
          <div className="compare-head">
            <div className="compare-title">
              <span className="compare-kicker">Compare</span>
              {relation ? (
                <>
                  <span className="compare-where">{relation.where}</span>
                  <span className="compare-current">
                    {relation.current} · drag the white probe to test
                    other points
                  </span>
                </>
              ) : (
                <span className="compare-current">
                  Pick crossing A and crossing B on the slice
                </span>
              )}
            </div>

            <div className="toolbar-group">
              <button
                className="control"
                onClick={pickNeighbours}
                disabled={turns < 2}
                title="Two neighbouring turns on the same side"
              >
                Neighbours
              </button>
              <button
                className="control"
                onClick={pickOpposite}
                disabled={turns < 1}
                title="The top and bottom of one turn"
              >
                Opposite sides
              </button>
              <button
                className="control"
                onClick={() => setSelection({ a: null, b: null })}
                disabled={!selection.a && !selection.b}
              >
                Clear
              </button>
            </div>
          </div>

          {miniLabels.map((label, k) => (
            <div className="mini" key={label}>
              <canvas
                ref={(el) => {
                  miniRefs.current[k] = el;
                }}
              />
              <span className={`mini-chip chip-${k}`}>{label}</span>
              {!pairReady && (
                <span className="mini-empty">
                  {k === 0
                    ? selection.a
                      ? ''
                      : 'Click a crossing to make it A'
                    : k === 1
                      ? selection.b
                        ? ''
                        : 'Then another to make it B'
                      : 'Their combined field appears here'}
                </span>
              )}
            </div>
          ))}

          <div className="verdict" aria-live="polite">
            {readout ? (
              <>
                <p className="verdict-text">
                  <span className={`verdict-badge ${verdict}`}>
                    {verdictLabel}
                  </span>
                  {explanation}
                </p>

                <div className="bars">
                  {bars.map((bar) => (
                    <div className={`${bar.cls}`} key={bar.label} style={{ display: 'contents' }}>
                      <span>{bar.label}</span>
                      <span className="bar-track">
                        <span
                          className="bar-fill"
                          style={{
                            display: 'block',
                            width: `${(bar.value / barMax) * 100}%`,
                          }}
                        />
                      </span>
                      <span className="bar-value">
                        {bar.value.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <span className="verdict-empty">
                Try <b>Neighbours</b>: two turns side by side carry
                current the same way, so between them their fields
                oppose. Then try <b>Opposite sides</b>: the top and
                bottom of a turn carry current opposite ways, so inside
                the coil their fields line up.
              </span>
            )}
          </div>
        </section>

        <div className="slice-progress">
          <div className="progress-meta">
            <span>
              {turns} of {SLICE_MAX_TURNS} turns wrapped
            </span>

            <span>
              {turns === SLICE_MAX_TURNS
                ? 'Coil complete'
                : 'Click the bar to jump to a turn count'}
            </span>
          </div>

          {/* Unwrap · Wrap · progress */}
          <div
            className="progress-row"
            onPointerDownCapture={() => setBarAttention(false)}
          >
            <button
              className="control"
              onClick={handleUnwrap}
              disabled={animating || turns <= 0}
            >
              Unwrap
            </button>

            <button
              className="control primary"
              onClick={handleWrap}
              disabled={animating || turns >= SLICE_MAX_TURNS}
            >
              Wrap
            </button>

            <div
              className="progress-hit"
              role="slider"
              tabIndex={0}
              aria-label="Turns wrapped"
              aria-valuemin={0}
              aria-valuemax={SLICE_MAX_TURNS}
              aria-valuenow={turns}
              onClick={(e) => requestTurns(turnsAtPointer(e))}
              onPointerMove={(e) => {
                if (e.buttons & 1) requestTurns(turnsAtPointer(e));
              }}
              onKeyDown={handleProgressKey}
            >
              {barAttention && (
                <span className="bar-hint" aria-hidden="true">
                  Click here
                </span>
              )}

              <div
                className={`progress-bar slice-bar${
                  barAttention ? ' attention' : ''
                }`}
              >
                <div
                  ref={progressFillRef}
                  className="progress-fill slice-fill"
                  style={{
                    width: `${(turns / SLICE_MAX_TURNS) * 100}%`,
                  }}
                />
              </div>
            </div>
          </div>

          <div className="progress-switch">
            {switcher}
          </div>
        </div>
      </div>
    </div>
  );
}

function ScreenSwitcher({ screen, onChange }) {
  const tabs = [
    ['coil', '3D coil'],
    ['slice', 'Cross-section'],
  ];

  return (
    <div
      className="screen-switcher"
      role="tablist"
      aria-label="Choose a view"
    >
      {tabs.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={screen === key}
          className={`screen-tab${screen === key ? ' active' : ''}`}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState('coil');
  const [sliceOpened, setSliceOpened] = useState(false);

  function changeScreen(next) {
    if (next === 'slice') setSliceOpened(true);
    setScreen(next);
  }

  const switcher = (
    <ScreenSwitcher screen={screen} onChange={changeScreen} />
  );

  return (
    <>
      <style>{`
        .screen-host[hidden] {
          display: none !important;
        }

        .screen-switcher {
          display: inline-flex;
          gap: 2px;
          padding: 2px;
          border: 1px solid rgba(147, 212, 240, 0.18);
          border-radius: 11px;
          background: rgba(8, 20, 30, 0.78);
          backdrop-filter: blur(10px);
          pointer-events: auto;
        }

        .screen-tab {
          padding: 6px 12px;
          border: 1px solid transparent;
          border-radius: 8px;
          background: transparent;
          color: #a9c6d3;
          font: inherit;
          font-size: 11.5px;
          font-weight: 750;
          white-space: nowrap;
          cursor: pointer;
          transition:
            background .15s ease,
            border-color .15s ease,
            color .15s ease;
        }

        .screen-tab:hover:not(.active) {
          background: rgba(11, 32, 45, 0.9);
          color: #eaf8ff;
        }

        .screen-tab.active {
          border-color: #62e6ff;
          background: rgba(23, 83, 105, 0.95);
          color: #eaf8ff;
          box-shadow: 0 0 14px rgba(98, 230, 255, 0.18);
        }

        .screen-tab:focus-visible {
          outline: 2px solid rgba(98, 230, 255, 0.6);
          outline-offset: 1px;
        }
      `}</style>

      <div className="screen-host" hidden={screen !== 'coil'}>
        <CoilView switcher={switcher} />
      </div>

      {sliceOpened && (
        <div className="screen-host" hidden={screen !== 'slice'}>
          <SliceView switcher={switcher} active={screen === 'slice'} />
        </div>
      )}
    </>
  );
}