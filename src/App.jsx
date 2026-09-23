import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './App.css';

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

const COIL_RADIUS = 1.75;
const COIL_PITCH = 0.2;
const COIL_TURNS = 6.5;

// Number of points used to actually curve each wire section.
const SECTION_CURVE_SAMPLES = 8;

// Visual field resolution.
const FIELD_STEPS = 7;

// Shift+click can highlight at most this many sections at once.
const MAX_SELECTED_SECTIONS = 2;

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
 * Boundary points between sections.
 */
function makeCoilPoint(index) {
  return coilPointAt(
    index / SECTION_COUNT,
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

function makeStraightPoint(index) {
  const total =
    SECTION_COUNT * SECTION_LENGTH;

  return new THREE.Vector3(
    -total / 2 +
      index * SECTION_LENGTH,
    0,
    0,
  ).add(STRAIGHT_OFFSET);
}

function getTargetPoints() {
  return Array.from(
    { length: SECTION_COUNT + 1 },
    (_, i) => makeCoilPoint(i),
  );
}

function getStraightPoints() {
  return Array.from(
    { length: SECTION_COUNT + 1 },
    (_, i) => makeStraightPoint(i),
  );
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
 *
 * We intentionally do NOT use `sectionIndex >= wrappedCount`
 * here to decide whether the section is straight. Doing that
 * causes sections after the first animated section to remain
 * completely straight until the animation finishes.
 */
function getSectionPath(
  sectionIndex,
  wrappedCount,
  animatedWrap = 1,
  pitch = COIL_PITCH,
) {
  const straightA =
    makeStraightPoint(sectionIndex);

  const straightB =
    makeStraightPoint(sectionIndex + 1);

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
  animatedWrap = 1,
  pitch = COIL_PITCH,
) {
  return Array.from(
    { length: SECTION_COUNT },
    (_, i) => {
      const wrapAmount =
        i < wrappedCount
          ? animatedWrap
          : 0;

      return getSectionPath(
        i,
        wrappedCount,
        wrapAmount,
        pitch,
      );
    },
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
) {
  const easingT =
    Math.max(0, Math.min(1, t));

  const paths = [];

  for (
    let i = 0;
    i < SECTION_COUNT;
    i++
  ) {
    let wrapAmount = 0;

    if (toCount > fromCount) {
      /*
       * Already wrapped sections stay fully wrapped.
       */
      if (i < fromCount) {
        wrapAmount = 1;
      }
      /*
       * Every newly-added section curls at
       * the same time.
       */
      else if (
        i < toCount
      ) {
        wrapAmount = easingT;
      }
    } else if (toCount < fromCount) {
      /*
       * Sections remaining in the coil stay wrapped.
       */
      if (i < toCount) {
        wrapAmount = 1;
      }
      /*
       * Every section being removed uncurls
       * at the same time.
       */
      else if (
        i < fromCount
      ) {
        wrapAmount =
          1 - easingT;
      }
    } else {
      wrapAmount =
        i < fromCount ? 1 : 0;
    }

    paths.push(
      getSectionPath(
        i,
        1,
        wrapAmount,
        pitch,
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
 * Approximate Biot-Savart contribution from a tiny straight
 * element between a and b.
 */
function segmentField(
  point,
  a,
  b,
) {
  const dl =
    new THREE.Vector3().subVectors(
      b,
      a,
    );

  const mid =
    new THREE.Vector3()
      .addVectors(a, b)
      .multiplyScalar(0.5);

  const r =
    new THREE.Vector3().subVectors(
      point,
      mid,
    );

  const rSq = Math.max(
    r.lengthSq(),
    0.035,
  );

  const cross =
    new THREE.Vector3()
      .crossVectors(dl, r);

  cross.multiplyScalar(
    1 / Math.pow(
      rSq,
      1.5,
    ),
  );

  return cross;
}

/*
 * Field generated by ONE curved wire section.
 */
function curvedSectionField(
  point,
  sectionPath,
) {
  const field =
    new THREE.Vector3();

  for (
    let i = 0;
    i <
    sectionPath.length - 1;
    i++
  ) {
    field.add(
      segmentField(
        point,
        sectionPath[i],
        sectionPath[i + 1],
      ),
    );
  }

  return field;
}

/*
 * Combined field from all wrapped sections.
 */
function coilField(
  point,
  sectionPaths,
  activeCount,
) {
  const field =
    new THREE.Vector3();

  for (
    let sectionIndex = 0;
    sectionIndex < activeCount;
    sectionIndex++
  ) {
    field.add(
      curvedSectionField(
        point,
        sectionPaths[
          sectionIndex
        ],
      ),
    );
  }

  return field;
}

/*
 * Field from one selected section.
 */
function singleSectionField(
  point,
  sectionPaths,
  sectionIndex,
) {
  if (
    sectionIndex == null ||
    sectionIndex < 0 ||
    sectionIndex >=
      sectionPaths.length
  ) {
    return new THREE.Vector3();
  }

  return curvedSectionField(
    point,
    sectionPaths[
      sectionIndex
    ],
  );
}

/*
 * Field from a SET of selected sections.
 */
function selectedSectionsField(
  point,
  sectionPaths,
  sectionIndices,
) {
  const field =
    new THREE.Vector3();

  if (
    !sectionIndices ||
    !sectionIndices.length
  ) {
    return field;
  }

  sectionIndices.forEach(
    (sectionIndex) => {
      if (
        sectionIndex == null ||
        sectionIndex < 0 ||
        sectionIndex >=
          sectionPaths.length
      ) {
        return;
      }

      field.add(
        curvedSectionField(
          point,
          sectionPaths[
            sectionIndex
          ],
        ),
      );
    },
  );

  return field;
}

/*
 * Trace a field line using the COMBINED field.
 */
function traceCombinedStreamline(
  seed,
  directionSign,
  sectionPaths,
  activeCount,
) {
  const linePoints = [];
  let p = seed.clone();

  for (
    let step = 0;
    step < 150;
    step++
  ) {
    linePoints.push(
      p.clone(),
    );

    const b =
      coilField(
        p,
        sectionPaths,
        activeCount,
      );

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

    b.normalize().multiplyScalar(
      directionSign * 0.14,
    );

    p.add(b);

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
 * Trace a field line generated by ONE section.
 */
function traceIndividualStreamline(
  seed,
  directionSign,
  sectionPaths,
  sectionIndex,
) {
  const linePoints = [];
  let p = seed.clone();

  for (
    let step = 0;
    step < 125;
    step++
  ) {
    linePoints.push(
      p.clone(),
    );

    const b =
      singleSectionField(
        p,
        sectionPaths,
        sectionIndex,
      );

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

    b.normalize().multiplyScalar(
      directionSign * 0.15,
    );

    p.add(b);

    if (
      Math.abs(p.x) > 13 ||
      Math.abs(p.y) > 11 ||
      Math.abs(p.z) > 12
    ) {
      break;
    }
  }

  return linePoints;
}

/*
 * Trace a field line generated by a SET of selected sections.
 */
function traceSelectionStreamline(
  seed,
  directionSign,
  sectionPaths,
  sectionIndices,
) {
  const linePoints = [];
  let p = seed.clone();

  for (
    let step = 0;
    step < 125;
    step++
  ) {
    linePoints.push(
      p.clone(),
    );

    const b =
      selectedSectionsField(
        p,
        sectionPaths,
        sectionIndices,
      );

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

    b.normalize().multiplyScalar(
      directionSign * 0.15,
    );

    p.add(b);

    if (
      Math.abs(p.x) > 13 ||
      Math.abs(p.y) > 11 ||
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

function makeSectionSeeds(
  sectionPath,
) {
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

  const helper =
    Math.abs(
      tangent.dot(
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
        tangent,
        helper,
      )
      .normalize();

  const v =
    new THREE.Vector3()
      .crossVectors(
        tangent,
        u,
      )
      .normalize();

  const seeds = [];

  const loops = 0;
  const radius = 0.15;

  for (
    let i = 0;
    i < loops;
    i++
  ) {
    const angle =
      (i / loops) *
      Math.PI *
      2;

    seeds.push(
      center
        .clone()
        .addScaledVector(
          u,
          Math.cos(angle) *
            radius,
        )
        .addScaledVector(
          v,
          Math.sin(angle) *
            radius,
        ),
    );
  }

  return seeds;
}

/*
 * Combined-field view.
 */
function buildCombinedField(
  sectionPaths,
  activeCount,
) {
  const group =
    new THREE.Group();

  if (activeCount <= 0) {
    return group;
  }

  const seeds = [];

  const loops = 10;

  for (
    let xIndex = 0;
    xIndex < 3;
    xIndex++
  ) {
    const sectionIndex =
      Math.min(
        activeCount - 1,
        Math.floor(
          (xIndex / 2) *
            Math.max(
              activeCount - 1,
              0,
            ),
        ),
      );

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

    for (
      let i = 0;
      i < loops;
      i++
    ) {
      const angle =
        (i / loops) *
        Math.PI *
        2;

      seeds.push(
        new THREE.Vector3(
          center.x,
          Math.cos(angle) *
            2.4,
          2.1 +
            Math.sin(angle) *
              2.4,
        ),
      );
    }
  }

  seeds.forEach(
    (seed, seedIndex) => {
      const traced =
        traceCombinedStreamline(
          seed,
          1,
          sectionPaths,
          activeCount,
        );

      if (traced.length < 8) {
        return;
      }

      const geometry =
        new THREE.BufferGeometry()
          .setFromPoints(
            traced,
          );

      const colors = [
        0x4de4ff,
        0x68b5ff,
        0x8c7bff,
      ];

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
 * Every wrapped section gets its own independent field visualization.
 */
function buildAllContributionsField(
  sectionPaths,
  activeCount,
) {
  const group =
    new THREE.Group();

  if (activeCount <= 0) {
    return group;
  }

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
    sectionIndex < activeCount;
    sectionIndex++
  ) {
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
        group.add(
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

    const seeds =
      makeSectionSeeds(
        sectionPath,
      );

    seeds.forEach((seed) => {
      const traced =
        traceIndividualStreamline(
          seed,
          1,
          sectionPaths,
          sectionIndex,
        );

      if (traced.length < 7) {
        return;
      }

      const geometry =
        new THREE.BufferGeometry()
          .setFromPoints(
            traced,
          );

      const material =
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: 0.26,
          depthWrite: false,
        });

      group.add(
        new THREE.Line(
          geometry,
          material,
        ),
      );
    });
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

      const seeds =
        makeSectionSeeds(
          sectionPath,
        );

      seeds.forEach((seed) => {
        const traced =
          traceSelectionStreamline(
            seed,
            1,
            sectionPaths,
            validIndices,
          );

        if (traced.length < 7) {
          return;
        }

        const geometry =
          new THREE.BufferGeometry()
            .setFromPoints(
              traced,
            );

        const material =
          new THREE.LineBasicMaterial({
            color: 0xff76da,
            transparent: true,
            opacity: 0.62,
            depthWrite: false,
          });

        group.add(
          new THREE.Line(
            geometry,
            material,
          ),
        );
      });

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
      wrappedCount > 0
        ? `All ${wrappedCount} wrapped sections shown independently`
        : 'Wrap sections to reveal their fields';
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
                : 'pink'
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

  const stateRef =
    useRef({
      wrappedCount: 0,
      selectedSections: [],
      mode: 'combined',
    });

  const [coilPitch, setCoilPitch] =
    useState(COIL_PITCH);

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

    const renderer =
      new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
      });

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

    root.add(fieldGroup);
    root.add(wireGroup);
    root.add(
      interactionGroup,
    );
    root.add(pulseGroup);

    const raycaster =
      new THREE.Raycaster();

    const pointer =
      new THREE.Vector2();

    let animationFrame = 0;
    let animationStart = 0;
    let animationKind = null;
    let animationFrom = 0;
    let animationTo = 0;

    const hitTargets = [];

    const state = {
      sectionPaths:
        getAllSectionPaths(
          0,
          1,
          coilPitchRef.current,
        ),

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
    ) {
      while (
        wireGroup.children.length
      ) {
        const child =
          wireGroup.children.pop();

        disposeObject(child);
      }

      while (
        interactionGroup.children.length
      ) {
        const child =
          interactionGroup.children.pop();

        disposeObject(child);
      }

      while (
        pulseGroup.children.length
      ) {
        const child =
          pulseGroup.children.pop();

        disposeObject(child);
      }

      hitTargets.length = 0;

      const selections =
        activeSelections || [];

      for (
        let i = 0;
        i < SECTION_COUNT;
        i++
      ) {
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

        mesh.castShadow = true;

        wireGroup.add(mesh);
        hitTargets.push(mesh);

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

            interactionGroup.add(
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

            interactionGroup.add(
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
              ? 0.22
              : Math.min(
                  0.42,
                  SECTION_LENGTH * 0.7,
                ),
            isSelected
              ? 0xffc0ec
              : 0xffc477,
            0.12,
            0.07,
          );

        arrow.userData.sectionIndex =
          i;

        interactionGroup.add(
          arrow,
        );

        /*
         * Small current markers.
         */
        [0.3, 0.7].forEach(
          (t) => {
            const index =
              Math.floor(
                t *
                  (sectionPath.length -
                    1),
              );

            const marker =
              new THREE.Mesh(
                new THREE.SphereGeometry(
                  0.035,
                  8,
                  8,
                ),
                new THREE.MeshBasicMaterial({
                  color:
                    isSelected
                      ? 0xffe3f6
                      : 0xffd9ad,

                  transparent: true,

                  opacity:
                    isSelected
                      ? 1
                      : 0.65,
                }),
              );

            marker.position.copy(
              sectionPath[index],
            );

            pulseGroup.add(
              marker,
            );
          },
        );
      }
    }

    /*
     * Rebuild all field visualizations.
     */
    function rebuildFields(
      sectionPaths,
      activeCount,
      activeSelections,
    ) {
      while (
        fieldGroup.children.length
      ) {
        const child =
          fieldGroup.children.pop();

        disposeObject(child);
      }

      const combined =
        buildCombinedField(
          sectionPaths,
          activeCount,
        );

      const allContributions =
        buildAllContributionsField(
          sectionPaths,
          activeCount,
        );

      const individual =
        buildSectionField(
          sectionPaths,
          activeSelections,
        );

      combined.name =
        'combinedField';

      allContributions.name =
        'allContributionsField';

      individual.name =
        'individualField';

      [
        combined,
        allContributions,
        individual,
      ].forEach((group) => {
        group.traverse((obj) => {
          if (
            obj.material &&
            'opacity' in
              obj.material
          ) {
            obj.material.userData =
              {
                ...(
                  obj.material
                    .userData || {}
                ),

                fieldMode:
                  group.name,

                baseOpacity:
                  obj.material
                    .opacity,
              };
          }
        });
      });

      fieldGroup.add(
        combined,
      );

      fieldGroup.add(
        allContributions,
      );

      fieldGroup.add(
        individual,
      );

      updateFieldBlend();
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
    }

    function handlePitchChange(
      pitch,
    ) {
      if (animationKind) {
        return;
      }

      const paths =
        getAllSectionPaths(
          stateRef.current
            .wrappedCount,
          1,
          pitch,
        );

      rebuildAll(paths);
    }

    function handleCombined() {
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
        ].slice(
          -MAX_SELECTED_SECTIONS,
        );
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

    function onPointerDown(
      event,
    ) {
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
          event.shiftKey,
        );
      }
    }

    renderer.domElement.addEventListener(
      'pointerdown',
      onPointerDown,
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
        1,
        coilPitchRef.current,
      ),
    );

    function animate(now) {
      animationFrame =
        requestAnimationFrame(
          animate,
        );

      if (animationKind) {
        const elapsed =
          Math.min(
            (now -
              animationStart) /
              1720,
            1,
          );

        const eased =
          elapsed *
          elapsed *
          (3 - 2 * elapsed);

        const paths =
          getAnimatedSectionPaths(
            animationFrom,
            animationTo,
            eased,
            coilPitchRef.current,
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
        );

        rebuildFields(
          paths,
          fieldCount,
          stateRef.current
            .selectedSections,
        );

        state.sectionPaths =
          paths.map(
            (path) =>
              path.map((p) =>
                p.clone(),
              ),
          );

        if (elapsed >= 1) {
          animationKind = null;

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
              1,
              coilPitchRef.current,
            );

          rebuildAll(
            finalPaths,
          );
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

      pulseGroup.children.forEach(
        (marker, index) => {
          marker.scale.setScalar(
            0.88 +
              Math.sin(
                now * 0.004 +
                  index,
              ) *
                0.12,
          );
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
      wrapNext:
        handleWrapNext,

      undo:
        handleUndo,

      combined:
        handleCombined,

      allContributions:
        handleAllContributions,

      jumpTo:
        handleJumpTo,

      pitchChange:
        handlePitchChange,
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

      controls.dispose();

      disposeObject(scene);

      renderer.dispose();

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

  const triggerCombined = () => {
    setMode('combined');
    setSelectedSections([]);

    mountRef.current?._magneticTool?.combined();
  };

  const triggerAllContributions =
    () => {
      setMode('all');
      setSelectedSections([]);

      mountRef.current?._magneticTool
        ?.allContributions();
    };

  const handlePitchSliderChange =
    (event) => {
      const value =
        Number(event.target.value);

      setCoilPitch(value);

      mountRef.current?._magneticTool
        ?.pitchChange(value);
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
          min-height: 100vh;
          margin: 0;
          padding: 20px;
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
          width: min(1180px, 100%);
          height: min(
            760px,
            calc(100vh - 40px)
          );
          min-height: 620px;
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

        .top-left {
          top: 20px;
          left: 22px;
          width: min(
            430px,
            calc(100% - 44px)
          );
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

        .subtitle {
          margin-top: 8px;
          max-width: 390px;
          font-size: 14px;
          line-height: 1.45;
          color: #a8c5d3;
        }

        .top-right {
          top: 20px;
          right: 20px;
          pointer-events: auto;
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
          max-width: 480px;
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

        .control.secondary {
          color: #ffd2f1;
          border-color:
            rgba(
              255,
              118,
              218,
              0.25
            );
        }

        .control.multicolor {
          color: #dffcff;
          border-color:
            rgba(
              92,
              224,
              207,
              0.3
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
          bottom: 72px;
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
          position: absolute;
          top: 102px;
          left: 22px;
          z-index: 4;
          pointer-events: none;
          padding: 9px 11px;
          border-radius: 10px;
          background:
            rgba(
              5,
              14,
              22,
              0.58
            );
          border: 1px solid
            rgba(
              160,
              218,
              240,
              0.12
            );
          color: #82a5b5;
          font-size: 11px;
          line-height: 1.4;
        }

        @media (max-width: 1000px) {
          .top-right {
            max-width: 430px;
          }

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

          .top-right {
            max-width: 340px;
          }

          .help {
            top: 140px;
          }
        }

        @media (max-width: 620px) {
          .subtitle {
            display: none;
          }

          .top-left {
            width: 55%;
          }

          .top-right {
            top: 70px;
            left: 18px;
            right: 18px;
            justify-content: flex-start;
          }

          .help {
            top: 158px;
            max-width: 250px;
          }

          .field-legend {
            display: none;
          }

          .progress-wrap {
            bottom: 65px;
          }
        }
      `}</style>

      <div className="magnetic-panel">
        <div
          ref={mountRef}
          className="three-stage"
        />

        <div className="hud top-left">
          <div className="kicker">
            Magnetism · 3D exploration
          </div>

          <h1 className="title">
            From straight wire to
            solenoid
          </h1>
        </div>

        <div className="hud top-right">

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

          <button
            className="control"
            onClick={triggerCombined}
          >
            Combined field
          </button>

          <button
            className="control multicolor"
            onClick={
              triggerAllContributions
            }
          >
            Contributions to field
          </button>

          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              marginTop: 10,
            }}
          >
            <span>
              Coil pitch: {coilPitch.toFixed(3)}
            </span>

            <input
              type="range"
              min="0.03"
              max="0.30"
              step="0.005"
              value={coilPitch}
              onChange={(e) => {
                const value =
                  Number(e.target.value);

                setCoilPitch(value);

                mountRef.current?._magneticTool
                  ?.pitchChange(value);
              }}
            />
          </label>

        </div>

        <div className="help">
          Drag = orbit · Wheel = zoom ·
          Right-drag = pan · Click a
          wrapped section = isolate its
          field · Shift+click a second
          section = compare two fields ·
          Click or drag the progress bar
          to jump to a section count
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
            'Every wrapped section has its own independently rendered, color-coded field.'}

          {mode === 'individual' &&
            (selectedSections.length ===
            2
              ? `Sections ${
                  selectedSections[0] +
                  1
                } & ${
                  selectedSections[1] +
                  1
                } are isolated — pink field lines show their combined contribution.`
              : `Section ${
                  (selectedSections[0] ??
                    0) + 1
                } is isolated — pink field lines show only its contribution.`)}
        </div>
        
        <div style={{ marginTop: 10 }}>
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
    </div>
  );
}