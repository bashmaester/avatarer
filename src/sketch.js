const MEDIAPIPE_VERSION = '0.10.18';
const MEDIAPIPE_BUNDLE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const MEDIAPIPE_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

const LM = {
  nose: 0,
  leftEyeInner: 1,
  leftEye: 2,
  leftEyeOuter: 3,
  rightEyeInner: 4,
  rightEye: 5,
  rightEyeOuter: 6,
  leftEar: 7,
  rightEar: 8,
  mouthLeft: 9,
  mouthRight: 10,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftFootIndex: 31,
  rightFootIndex: 32,
};

const TARGET_LABELS = {
  leftWrist: 'left hand',
  rightWrist: 'right hand',
  leftAnkle: 'left foot',
  rightAnkle: 'right foot',
  head: 'head / gaze',
};

const ui = {
  status: document.querySelector('#driver-status'),
  startCamera: document.querySelector('#start-camera'),
  modeButtons: [...document.querySelectorAll('[data-mode]')],
  targetButtons: [...document.querySelectorAll('[data-target]')],
  seedInput: document.querySelector('#seed-input'),
  reroll: document.querySelector('#reroll'),
  followMouse: document.querySelector('#follow-mouse'),
  showRig: document.querySelector('#show-rig'),
  showVideo: document.querySelector('#show-video'),
  mirrorVideo: document.querySelector('#mirror-video'),
  smoothLive: document.querySelector('#smooth-live'),
  video: document.querySelector('#input-video'),
};

const state = {
  mode: 'manual',
  dna: createDNA(ui.seedInput.value),
  now: 0,
  dt: 1 / 60,
  keys: new Set(),
  pointer: { x: 0, y: 0, active: false, down: false, lastMove: 0 },
  options: {
    followMouse: ui.followMouse.checked,
    showRig: ui.showRig.checked,
    showVideo: ui.showVideo.checked,
    mirrorVideo: ui.mirrorVideo.checked,
    smoothLive: ui.smoothLive.checked,
  },
  manual: createManualState(),
  media: {
    status: 'idle',
    loading: false,
    landmarker: null,
    landmarks: null,
    worldLandmarks: null,
    lastVideoTime: -1,
    lastDetectMs: 0,
    confidence: 0,
    raf: 0,
    usingDelegate: 'GPU',
  },
  liveRig: null,
  paperDots: [],
  lastStatusAt: 0,
};

wireControls();

if (!window.p5) {
  setStatus('p5.js did not load. Check your network connection and reload.');
} else {
  new window.p5(makeSketch);
}

function makeSketch(p) {
  p.setup = () => {
    const holder = document.querySelector('#canvas-holder');
    const canvas = p.createCanvas(holder.clientWidth, holder.clientHeight);
    canvas.parent(holder);
    p.pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
    p.frameRate(60);
    regeneratePaper(p);
    centerPointer(p);
  };

  p.windowResized = () => {
    const holder = document.querySelector('#canvas-holder');
    p.resizeCanvas(holder.clientWidth, holder.clientHeight);
    regeneratePaper(p);
    centerPointer(p);
  };

  p.draw = () => {
    const now = p.millis() / 1000;
    state.dt = Math.min(0.045, Math.max(0.001, now - state.now || 1 / 60));
    state.now = now;

    updateKeyboardRig(state.dt);
    drawScene(p, now, state.dt);
  };

  p.mouseMoved = () => updatePointer(p, false);
  p.mouseDragged = () => updatePointer(p, true);
  p.mousePressed = () => updatePointer(p, true);
  p.mouseReleased = () => {
    state.pointer.down = false;
    updatePointer(p, false);
  };
}

function drawScene(p, now, dt) {
  drawPaper(p);

  if (state.options.showVideo && state.media.status === 'running') {
    drawVideoGhost(p);
  }

  const rig = getActiveRig(p, now, dt);
  drawCharacter(p, rig, state.dna, now);

  if (state.options.showRig) {
    drawRigOverlay(p, rig);
  }

  drawCanvasHud(p, rig);
  refreshStatusOccasionally(now, rig);
}

function getActiveRig(p, now, dt) {
  if (state.mode === 'mediapipe' && state.media.landmarks) {
    const target = rigFromMediaPipe(p, state.media.landmarks, now);
    if (target) {
      if (state.options.smoothLive && state.liveRig) {
        const alpha = 1 - Math.exp(-dt * 13);
        state.liveRig = blendRig(state.liveRig, target, alpha);
      } else {
        state.liveRig = target;
      }
      return state.liveRig;
    }
  }

  return buildManualRig(p, now, dt, state.mode === 'mediapipe');
}

function buildManualRig(p, now, _dt, ghostMode = false) {
  const dna = state.dna;
  const m = state.manual;
  const unit = Math.max(54, Math.min(p.height * 0.165, p.width * 0.18));
  const moving = Math.hypot(m.moveX, m.moveY);
  const walkLift = moving > 0.02 ? Math.sin(m.gait * 2) * unit * 0.018 : 0;
  const jump = m.jump * Math.sin(now * 8.2) * unit * 0.17;
  const root = {
    x: p.width * m.rootN.x,
    y: p.height * m.rootN.y + walkLift - jump,
  };

  const crouch = m.crouch;
  const torsoAngle = m.lean * 0.42 + m.moveX * 0.08;
  const up = rotate({ x: 0, y: -1 }, torsoAngle);
  const side = rotate({ x: 1, y: 0 }, torsoAngle * 0.25);
  const shoulderW = unit * (1.02 + dna.shoulder * 0.18);
  const hipW = unit * (0.76 + dna.hip * 0.14);
  const torsoLen = unit * (1.34 + dna.torso * 0.14 - crouch * 0.16);
  const upperArm = unit * (0.78 + dna.arm * 0.08);
  const lowerArm = unit * (0.76 + dna.arm * 0.08);
  const upperLeg = unit * (1.06 + dna.leg * 0.12);
  const lowerLeg = unit * (1.05 + dna.leg * 0.12);
  const neckLen = unit * 0.16;
  const headH = unit * (0.88 + dna.headTall * 0.12);

  const pelvis = { ...root };
  const chest = add(pelvis, mul(up, torsoLen));
  const neck = add(chest, mul(up, neckLen));
  const shoulderL = add(chest, mul(side, -shoulderW * 0.5));
  const shoulderR = add(chest, mul(side, shoulderW * 0.5));
  const hipL = add(pelvis, mul(side, -hipW * 0.5));
  const hipR = add(pelvis, mul(side, hipW * 0.5));

  const step = moving > 0.02 ? Math.sin(m.gait) : 0;
  const stepLiftL = moving > 0.02 ? Math.max(0, Math.sin(m.gait + Math.PI)) * unit * 0.15 : 0;
  const stepLiftR = moving > 0.02 ? Math.max(0, Math.sin(m.gait)) * unit * 0.15 : 0;
  const legDrop = (upperLeg + lowerLeg) * (0.91 - crouch * 0.16);
  let ankleL = {
    x: pelvis.x - hipW * 0.34 - step * unit * 0.24,
    y: pelvis.y + legDrop - stepLiftL - crouch * unit * 0.28,
  };
  let ankleR = {
    x: pelvis.x + hipW * 0.34 + step * unit * 0.24,
    y: pelvis.y + legDrop - stepLiftR - crouch * unit * 0.28,
  };

  let wristL = {
    x: shoulderL.x - unit * (0.45 + dna.arm * 0.08) - Math.sin(m.gait + Math.PI) * unit * moving * 0.1,
    y: shoulderL.y + unit * (1.03 - crouch * 0.06),
  };
  let wristR = {
    x: shoulderR.x + unit * (0.45 + dna.arm * 0.08) + Math.sin(m.gait + Math.PI) * unit * moving * 0.1,
    y: shoulderR.y + unit * (1.03 - crouch * 0.06),
  };

  const pointer = state.pointer.active ? state.pointer : { x: p.width * 0.66, y: p.height * 0.36 };
  if (state.options.followMouse && state.pointer.active && !ghostMode) {
    if (m.selected === 'leftWrist') wristL = clampReach(shoulderL, pointer, (upperArm + lowerArm) * 0.98);
    if (m.selected === 'rightWrist') wristR = clampReach(shoulderR, pointer, (upperArm + lowerArm) * 0.98);
    if (m.selected === 'leftAnkle') ankleL = clampReach(hipL, pointer, (upperLeg + lowerLeg) * 0.98);
    if (m.selected === 'rightAnkle') ankleR = clampReach(hipR, pointer, (upperLeg + lowerLeg) * 0.98);
  }

  const kneeL = solveTwoBone(hipL, ankleL, upperLeg, lowerLeg, 1);
  const kneeR = solveTwoBone(hipR, ankleR, upperLeg, lowerLeg, -1);
  const elbowL = solveTwoBone(shoulderL, wristL, upperArm, lowerArm, 1);
  const elbowR = solveTwoBone(shoulderR, wristR, upperArm, lowerArm, -1);

  const head = add(neck, mul(up, headH * 0.43));
  const headLook = sub(pointer, head);
  const targetYaw = state.pointer.active ? clamp(headLook.x / (unit * 3.25), -0.65, 0.65) : Math.sin(now * 0.8 + dna.motionPhase) * 0.16;
  const targetPitch = state.pointer.active ? clamp(headLook.y / (unit * 4.3), -0.38, 0.38) : Math.sin(now * 0.52 + 1.4 + dna.motionPhase) * 0.08;
  const gazeX = state.pointer.active ? clamp(headLook.x / (unit * 1.24), -1, 1) : Math.sin(now * 0.9 + dna.motionPhase) * 0.45;
  const gazeY = state.pointer.active ? clamp(headLook.y / (unit * 1.42), -1, 1) : Math.sin(now * 0.7 + dna.motionPhase) * 0.24;
  const blink = blinkEnvelope(m.blinkStarted, m.blinkUntil, now) || idleBlink(now, dna);
  const mouthOpen = Math.max(m.talkUntil > now ? chatter(now, dna) : 0, m.mouthPulse);
  const breath = Math.sin(now * (1.1 + dna.breathTempo) + dna.motionPhase) * 0.5 + 0.5;

  return {
    source: ghostMode ? 'waiting-for-camera' : 'manual',
    valid: true,
    confidence: ghostMode ? 0.25 : 1,
    unit,
    joints: {
      pelvis,
      chest,
      neck,
      head,
      shoulderL,
      shoulderR,
      elbowL,
      elbowR,
      wristL,
      wristR,
      hipL,
      hipR,
      kneeL,
      kneeR,
      ankleL,
      ankleR,
      footL: add(ankleL, { x: -unit * 0.23, y: unit * 0.05 }),
      footR: add(ankleR, { x: unit * 0.23, y: unit * 0.05 }),
    },
    face: {
      roll: torsoAngle * 0.38 + Math.sin(now * 0.97 + dna.motionPhase) * 0.015,
      yaw: targetYaw,
      pitch: targetPitch,
      gazeX,
      gazeY,
      blink,
      mouthOpen,
      breath,
      attention: state.pointer.active ? 1 : 0.35,
    },
  };
}

function rigFromMediaPipe(p, landmarks, now) {
  const minVis = 0.22;
  const point = (index, fallback = null) => landmarkPoint(p, landmarks[index], minVis, fallback);

  const shoulderL = point(LM.leftShoulder);
  const shoulderR = point(LM.rightShoulder);
  const hipL = point(LM.leftHip);
  const hipR = point(LM.rightHip);

  if (!shoulderL || !shoulderR) return null;

  const chest = avg(shoulderL, shoulderR);
  const pelvis = hipL && hipR ? avg(hipL, hipR) : { x: chest.x, y: chest.y + p.height * 0.24, score: 0.15 };
  let side = sub(shoulderR, shoulderL);
  const shoulderDistance = Math.max(1, length(side));
  side = normalize(side, { x: 1, y: 0 });
  let up = normalize(perp(side), { x: 0, y: -1 });
  if (up.y > 0) up = mul(up, -1);

  const torsoDistance = Math.max(1, dist(chest, pelvis));
  const unit = clamp(Math.max(shoulderDistance / (1.04 + state.dna.shoulder * 0.18), torsoDistance / 1.38), 42, Math.min(p.width, p.height) * 0.23);
  const neck = add(chest, mul(up, unit * 0.21));

  const nose = point(LM.nose);
  const leftEar = point(LM.leftEar);
  const rightEar = point(LM.rightEar);
  const earMid = leftEar && rightEar ? avg(leftEar, rightEar) : null;
  const head = inferHead(nose, earMid, neck, up, unit);

  const upperArm = unit * (0.78 + state.dna.arm * 0.08);
  const lowerArm = unit * (0.76 + state.dna.arm * 0.08);
  const upperLeg = unit * (1.06 + state.dna.leg * 0.12);
  const lowerLeg = unit * (1.05 + state.dna.leg * 0.12);

  const elbowL = point(LM.leftElbow, add(shoulderL, { x: -unit * 0.3, y: unit * 0.7 }));
  const elbowR = point(LM.rightElbow, add(shoulderR, { x: unit * 0.3, y: unit * 0.7 }));
  const wristL = point(LM.leftWrist, add(elbowL, { x: -unit * 0.25, y: unit * 0.7 }));
  const wristR = point(LM.rightWrist, add(elbowR, { x: unit * 0.25, y: unit * 0.7 }));
  const kneeL = point(LM.leftKnee, add(hipL || pelvis, { x: -unit * 0.15, y: upperLeg }));
  const kneeR = point(LM.rightKnee, add(hipR || pelvis, { x: unit * 0.15, y: upperLeg }));
  const ankleL = point(LM.leftAnkle, add(kneeL, { x: -unit * 0.08, y: lowerLeg }));
  const ankleR = point(LM.rightAnkle, add(kneeR, { x: unit * 0.08, y: lowerLeg }));
  const footL = point(LM.leftFootIndex, add(ankleL, mul(side, -unit * 0.22))) || add(ankleL, mul(side, -unit * 0.22));
  const footR = point(LM.rightFootIndex, add(ankleR, mul(side, unit * 0.22))) || add(ankleR, mul(side, unit * 0.22));

  const roll = Math.atan2(side.y, side.x) * 0.45;
  const yaw = earMid && nose ? clamp((nose.x - earMid.x) / Math.max(12, dist(leftEar || shoulderL, rightEar || shoulderR)) * 1.65, -0.7, 0.7) : 0;
  const pitch = earMid && nose ? clamp((nose.y - earMid.y) / Math.max(12, unit) * 1.2, -0.35, 0.38) : 0;
  const gazeX = clamp(yaw * 1.65, -1, 1);
  const gazeY = clamp(pitch * 2.1, -1, 1);
  const blink = idleBlink(now, state.dna);
  const mouthOpen = state.manual.talkUntil > now ? chatter(now, state.dna) : 0;
  const breath = Math.sin(now * (1.1 + state.dna.breathTempo) + state.dna.motionPhase) * 0.5 + 0.5;

  const confidence = averageScore([
    shoulderL,
    shoulderR,
    hipL,
    hipR,
    elbowL,
    elbowR,
    wristL,
    wristR,
    kneeL,
    kneeR,
    ankleL,
    ankleR,
  ]);
  state.media.confidence = confidence;

  return {
    source: 'mediapipe',
    valid: true,
    confidence,
    unit,
    joints: {
      pelvis,
      chest,
      neck,
      head,
      shoulderL,
      shoulderR,
      elbowL,
      elbowR,
      wristL,
      wristR,
      hipL: hipL || add(pelvis, mul(side, -unit * 0.38)),
      hipR: hipR || add(pelvis, mul(side, unit * 0.38)),
      kneeL,
      kneeR,
      ankleL,
      ankleR,
      footL,
      footR,
    },
    face: {
      roll,
      yaw,
      pitch,
      gazeX,
      gazeY,
      blink,
      mouthOpen,
      breath,
      attention: clamp(confidence * 1.35, 0.25, 1),
    },
  };
}

function drawCharacter(p, rig, dna, now) {
  const j = rig.joints;
  const u = rig.unit;
  const beat = Math.floor(now * 8 + dna.beatOffset);
  const ink = colorWithAlpha(dna.ink, rig.source === 'waiting-for-camera' ? 0.35 : 1);
  const ghost = rig.source === 'waiting-for-camera';

  p.push();
  if (ghost) p.drawingContext.globalAlpha = 0.52;

  drawGroundShadow(p, rig);

  drawLeg(p, j.hipL, j.kneeL, j.ankleL, j.footL, u, dna.pants, ink, 'leg-l', beat, -1);
  drawLeg(p, j.hipR, j.kneeR, j.ankleR, j.footR, u, dna.pants, ink, 'leg-r', beat, 1);

  drawArm(p, j.shoulderL, j.elbowL, j.wristL, u, dna, ink, 'arm-l', beat, -1, true);
  drawArm(p, j.shoulderR, j.elbowR, j.wristR, u, dna, ink, 'arm-r', beat, 1, true);

  drawTorso(p, rig, dna, ink, beat);
  drawNeck(p, rig, dna, ink, beat);

  drawArm(p, j.shoulderL, j.elbowL, j.wristL, u, dna, ink, 'arm-l-front', beat, -1, false);
  drawArm(p, j.shoulderR, j.elbowR, j.wristR, u, dna, ink, 'arm-r-front', beat, 1, false);

  drawHead(p, rig, dna, ink, beat, now);

  p.pop();
}

function drawGroundShadow(p, rig) {
  const { ankleL, ankleR, footL, footR } = rig.joints;
  const c = avg(avg(ankleL, ankleR), avg(footL, footR));
  const w = Math.max(rig.unit * 1.4, dist(footL, footR) + rig.unit * 0.5);
  p.push();
  p.noStroke();
  p.fill(40, 28, 20, rig.source === 'waiting-for-camera' ? 12 : 24);
  p.ellipse(c.x, c.y + rig.unit * 0.13, w, rig.unit * 0.23);
  p.pop();
}

function drawLeg(p, hip, knee, ankle, foot, u, fillColor, ink, trace, beat, sideSign) {
  const thighW = u * 0.22;
  const shinW = u * 0.19;
  drawSoftStroke(p, [hip, knee], fillColor, thighW, `${trace}-thigh-fill`, beat, 'round');
  drawSoftStroke(p, [hip, knee], ink, thighW + u * 0.045, `${trace}-thigh-outline`, beat, 'round', true);
  drawSoftStroke(p, [hip, knee], fillColor, thighW, `${trace}-thigh-fill-top`, beat, 'round');
  drawSoftStroke(p, [knee, ankle], fillColor, shinW, `${trace}-shin-fill`, beat, 'round');
  drawSoftStroke(p, [knee, ankle], ink, shinW + u * 0.04, `${trace}-shin-outline`, beat, 'round', true);
  drawSoftStroke(p, [knee, ankle], fillColor, shinW, `${trace}-shin-fill-top`, beat, 'round');

  const shoeDir = normalize(sub(foot, ankle), { x: sideSign, y: 0.08 });
  const shoeSide = perp(shoeDir);
  const shoe = [
    add(ankle, add(mul(shoeSide, -u * 0.095), mul(shoeDir, -u * 0.05))),
    add(foot, add(mul(shoeSide, -u * 0.11), mul(shoeDir, u * 0.1))),
    add(foot, add(mul(shoeSide, u * 0.1), mul(shoeDir, u * 0.03))),
    add(ankle, add(mul(shoeSide, u * 0.12), mul(shoeDir, -u * 0.08))),
  ];
  drawFilledShape(p, shoe, '#322a26', ink, `${trace}-shoe`, beat, u * 0.007);
}

function drawArm(p, shoulder, elbow, wrist, u, dna, ink, trace, beat, sideSign, behind) {
  const sleeveW = u * 0.19;
  const forearmW = u * 0.15;
  const alpha = behind ? 0.42 : 1;
  const shirt = colorWithAlpha(dna.shirt, alpha);
  const skin = colorWithAlpha(dna.skin, alpha);
  const line = colorWithAlpha(ink, alpha);

  if (behind) {
    drawSoftStroke(p, [shoulder, elbow], line, sleeveW + u * 0.042, `${trace}-sleeve-outline`, beat, 'round', true);
    drawSoftStroke(p, [shoulder, elbow], shirt, sleeveW, `${trace}-sleeve`, beat, 'round');
    drawSoftStroke(p, [elbow, wrist], line, forearmW + u * 0.036, `${trace}-fore-outline`, beat, 'round', true);
    drawSoftStroke(p, [elbow, wrist], skin, forearmW, `${trace}-fore`, beat, 'round');
    return;
  }

  drawSoftStroke(p, [shoulder, elbow], line, sleeveW + u * 0.04, `${trace}-sleeve-outline`, beat, 'round', true);
  drawSoftStroke(p, [shoulder, elbow], dna.shirt, sleeveW, `${trace}-sleeve`, beat, 'round');
  drawSoftStroke(p, [elbow, wrist], line, forearmW + u * 0.036, `${trace}-fore-outline`, beat, 'round', true);
  drawSoftStroke(p, [elbow, wrist], dna.skin, forearmW, `${trace}-fore`, beat, 'round');

  const handDir = normalize(sub(wrist, elbow), { x: sideSign, y: 0.2 });
  const palmCenter = add(wrist, mul(handDir, u * 0.06));
  drawBlobEllipse(p, palmCenter, u * 0.12, u * 0.15, Math.atan2(handDir.y, handDir.x) + Math.PI / 2, dna.skin, ink, `${trace}-hand`, beat);
  for (let i = -1; i <= 1; i++) {
    const finger = add(palmCenter, add(mul(handDir, u * 0.09), mul(perp(handDir), i * u * 0.036)));
    drawSoftStroke(p, [palmCenter, finger], ink, u * 0.012, `${trace}-finger-${i}`, beat, 'round');
  }
}

function drawTorso(p, rig, dna, ink, beat) {
  const { shoulderL, shoulderR, hipL, hipR, pelvis, chest } = rig.joints;
  const u = rig.unit;
  const side = normalize(sub(shoulderR, shoulderL), { x: 1, y: 0 });
  let up = normalize(perp(side), { x: 0, y: -1 });
  if (up.y > 0) up = mul(up, -1);
  const breath = rig.face.breath * u * 0.018;
  const waistL = add(hipL, add(mul(side, -u * 0.07), mul(up, u * 0.05)));
  const waistR = add(hipR, add(mul(side, u * 0.07), mul(up, u * 0.05)));
  const neckDip = add(chest, mul(up, u * 0.07 + breath));
  const points = [
    add(shoulderL, mul(up, -u * 0.04)),
    add(neckDip, mul(side, -u * 0.18)),
    add(neckDip, mul(side, u * 0.18)),
    add(shoulderR, mul(up, -u * 0.04)),
    waistR,
    add(pelvis, { x: 0, y: u * 0.13 }),
    waistL,
  ];

  drawFilledShape(p, points, dna.shirt, ink, 'torso-shirt', beat, u * 0.008);

  if (dna.pattern === 'stripe') {
    for (let i = 0.25; i <= 0.82; i += 0.18) {
      const left = lerpPoint(shoulderL, waistL, i);
      const right = lerpPoint(shoulderR, waistR, i);
      drawSoftStroke(p, [left, right], colorWithAlpha('#fff9ed', 0.45), u * 0.035, `shirt-stripe-${i.toFixed(2)}`, beat, 'round');
      drawSoftStroke(p, [left, right], colorWithAlpha(ink, 0.23), u * 0.008, `shirt-stripe-line-${i.toFixed(2)}`, beat, 'round');
    }
  } else if (dna.pattern === 'buttons') {
    const midTop = avg(shoulderL, shoulderR);
    const midBottom = avg(waistL, waistR);
    drawSoftStroke(p, [midTop, midBottom], colorWithAlpha(ink, 0.38), u * 0.014, 'shirt-placket', beat, 'round');
    for (let i = 0.22; i <= 0.78; i += 0.22) {
      const b = lerpPoint(midTop, midBottom, i);
      drawBlobEllipse(p, b, u * 0.025, u * 0.025, 0, '#fff7e9', colorWithAlpha(ink, 0.55), `button-${i}`, beat);
    }
  } else {
    const pocket = [
      add(chest, { x: u * 0.16, y: u * 0.18 }),
      add(chest, { x: u * 0.42, y: u * 0.17 }),
      add(chest, { x: u * 0.39, y: u * 0.39 }),
      add(chest, { x: u * 0.18, y: u * 0.41 }),
    ];
    drawFilledShape(p, pocket, colorWithAlpha('#ffffff', 0.24), colorWithAlpha(ink, 0.45), 'shirt-pocket', beat, u * 0.004);
  }
}

function drawNeck(p, rig, dna, ink, beat) {
  const { neck, chest, head } = rig.joints;
  const u = rig.unit;
  const dir = normalize(sub(chest, head), { x: 0, y: 1 });
  const side = perp(dir);
  const neckPoly = [
    add(neck, mul(side, -u * 0.13)),
    add(neck, mul(side, u * 0.13)),
    add(chest, add(mul(side, u * 0.1), mul(dir, -u * 0.18))),
    add(chest, add(mul(side, -u * 0.1), mul(dir, -u * 0.18))),
  ];
  drawFilledShape(p, neckPoly, dna.skin, ink, 'neck', beat, u * 0.005);
}

function drawHead(p, rig, dna, ink, beat, now) {
  const { head, neck, shoulderL, shoulderR } = rig.joints;
  const u = rig.unit;
  const f = rig.face;
  const roll = f.roll;
  const xAxis = rotate({ x: 1, y: 0 }, roll);
  const yAxis = rotate({ x: 0, y: 1 }, roll);
  const rx = u * (0.39 + dna.headWide * 0.06) * (1 - Math.abs(f.yaw) * 0.12);
  const ry = u * (0.51 + dna.headTall * 0.07);
  const faceCenter = add(head, add(mul(xAxis, f.yaw * u * 0.045), mul(yAxis, f.pitch * u * 0.045)));

  drawEar(p, faceCenter, xAxis, yAxis, -1, rx, ry, dna, ink, beat);
  drawEar(p, faceCenter, xAxis, yAxis, 1, rx, ry, dna, ink, beat);
  drawBlobEllipse(p, faceCenter, rx, ry, roll, dna.skin, ink, 'head-main', beat);

  drawHair(p, faceCenter, xAxis, yAxis, rx, ry, dna, ink, beat);
  drawFace(p, faceCenter, xAxis, yAxis, rx, ry, f, dna, ink, beat, now);

  const neckShadow = [
    add(neck, mul(xAxis, -u * 0.12)),
    add(neck, mul(xAxis, u * 0.12)),
  ];
  drawSoftStroke(p, neckShadow, colorWithAlpha(ink, 0.18), u * 0.018, 'neck-shadow', beat, 'round');

  const shoulderMid = avg(shoulderL, shoulderR);
  const attentionLine = add(shoulderMid, mul(yAxis, -u * 0.22));
  if (f.attention > 0.7) {
    drawSoftStroke(p, [add(faceCenter, mul(yAxis, ry * 0.88)), attentionLine], colorWithAlpha(ink, 0.14), u * 0.012, 'head-lift-line', beat, 'round');
  }
}

function drawEar(p, center, xAxis, yAxis, sign, rx, ry, dna, ink, beat) {
  const earCenter = add(center, add(mul(xAxis, sign * rx * 0.95), mul(yAxis, -ry * 0.04)));
  drawBlobEllipse(p, earCenter, rx * 0.15, ry * 0.22, Math.atan2(xAxis.y, xAxis.x), dna.skin, ink, `ear-${sign}`, beat);
  drawSoftStroke(
    p,
    [
      add(earCenter, mul(yAxis, -ry * 0.08)),
      add(earCenter, add(mul(xAxis, sign * rx * 0.04), mul(yAxis, ry * 0.07))),
      add(earCenter, mul(yAxis, ry * 0.13)),
    ],
    colorWithAlpha(ink, 0.45),
    rx * 0.022,
    `ear-fold-${sign}`,
    beat,
    'round',
  );
}

function drawHair(p, center, xAxis, yAxis, rx, ry, dna, ink, beat) {
  // Hair is drawn in head-local coordinates. Keeping all styles inside this
  // local frame prevents the common failure where the hairline drifts down
  // over the eyes or ignores the head roll.
  const to = (x, y) => add(center, add(mul(xAxis, x), mul(yAxis, y)));
  const roll = Math.atan2(xAxis.y, xAxis.x);
  const jitter = (trace, i, amount) => seededSigned(dna.seed, trace, beat, i) * amount;
  const hairLine = (n = 12, low = -0.3, wave = 0.035) => {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = lerp(-rx * 0.72, rx * 0.72, t);
      const y = ry * (low - Math.sin(t * Math.PI) * wave + jitter('hairline-y', i, 0.01));
      pts.push(to(x, y));
    }
    return pts;
  };

  if (dna.hairStyle === 'cap') {
    const cap = [];
    for (let i = 0; i <= 18; i++) {
      const t = i / 18;
      const x = lerp(-rx * 0.96, rx * 0.96, t);
      const crown = -0.27 - Math.sin(t * Math.PI) * 0.52;
      cap.push(to(x + jitter('hair-cap-x', i, rx * 0.015), ry * (crown + jitter('hair-cap-y', i, 0.012))));
    }
    const line = hairLine(12, -0.3, 0.045);
    cap.push(...line.slice().reverse());
    drawFilledShape(p, cap, dna.hair, ink, 'hair-cap', beat, rx * 0.012);
    drawSoftStroke(p, line, colorWithAlpha(ink, 0.62), rx * 0.016, 'hair-cap-line', beat, 'round');
  } else if (dna.hairStyle === 'bob') {
    const bob = [to(-rx * 0.82, ry * 0.35), to(-rx * 1.02, -ry * 0.12)];
    for (let i = 0; i <= 18; i++) {
      const t = i / 18;
      const x = lerp(-rx * 0.96, rx * 0.96, t);
      const y = ry * (-0.2 - Math.sin(t * Math.PI) * 0.54 + jitter('hair-bob-arc', i, 0.012));
      bob.push(to(x, y));
    }
    bob.push(to(rx * 1.02, -ry * 0.1), to(rx * 0.82, ry * 0.35), to(rx * 0.3, ry * 0.43), to(-rx * 0.25, ry * 0.42));
    drawFilledShape(p, bob, dna.hair, ink, 'hair-bob', beat, rx * 0.011);

    const fringe = hairLine(10, -0.29, 0.04);
    drawSoftStroke(p, fringe, colorWithAlpha(ink, 0.5), rx * 0.015, 'hair-bob-fringe', beat, 'round');
    for (let i = -2; i <= 2; i++) {
      const root = to(i * rx * 0.2, -ry * 0.57);
      const end = to(i * rx * 0.26 + jitter('hair-bob-strand-x', i + 4, rx * 0.03), -ry * (0.23 + Math.abs(i) * 0.025));
      drawSoftStroke(p, [root, end], colorWithAlpha(ink, 0.34), rx * 0.014, `hair-bob-strand-${i}`, beat, 'round');
    }
  } else if (dna.hairStyle === 'curls') {
    for (let i = -4; i <= 4; i++) {
      const arc = 1 - Math.abs(i) / 5;
      const base = to(i * rx * 0.21, -ry * (0.48 + arc * 0.17) + jitter('curl-y', i + 5, ry * 0.02));
      drawBlobEllipse(p, base, rx * 0.16, ry * 0.145, roll + i * 0.18, dna.hair, ink, `curl-${i}`, beat);
    }
    for (const side of [-1, 1]) {
      const sideCurl = to(side * rx * 0.82, -ry * 0.23);
      drawBlobEllipse(p, sideCurl, rx * 0.13, ry * 0.16, roll + side * 0.35, dna.hair, ink, `curl-side-${side}`, beat);
    }
    const fringe = hairLine(8, -0.28, 0.03);
    drawSoftStroke(p, fringe, colorWithAlpha(ink, 0.45), rx * 0.014, 'curl-fringe', beat, 'round');
  } else {
    const top = [];
    const n = 10;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = lerp(-rx * 0.82, rx * 0.82, t);
      const tall = i % 2 === 0 ? 0.67 : 0.79;
      const centerBoost = 0.06 * Math.sin(t * Math.PI);
      top.push(to(x + jitter('hair-spike-x', i, rx * 0.02), -ry * (tall + centerBoost + jitter('hair-spike-y', i, 0.018))));
    }
    const front = [];
    for (let i = n; i >= 0; i--) {
      const t = i / n;
      const x = lerp(-rx * 0.74, rx * 0.74, t);
      const y = -ry * (0.28 + (i % 2) * 0.035 + Math.sin(t * Math.PI) * 0.025);
      front.push(to(x, y));
    }
    drawFilledShape(p, [...top, ...front], dna.hair, ink, 'hair-spikes', beat, rx * 0.011);

    for (let i = -3; i <= 3; i++) {
      const root = to(i * rx * 0.2, -ry * 0.35);
      const tip = to(i * rx * 0.2 + jitter('hair-short-bang-x', i + 4, rx * 0.025), -ry * (0.22 + Math.abs(i) * 0.012));
      drawSoftStroke(p, [root, tip], colorWithAlpha(ink, 0.55), rx * 0.012, `hair-short-bang-${i}`, beat, 'round');
    }
  }
}

function drawFace(p, center, xAxis, yAxis, rx, ry, f, dna, ink, beat, now) {
  const skinInk = colorWithAlpha(ink, 0.82);
  const wake = f.attention;
  const eyeY = -ry * (0.13 + wake * 0.018) + f.pitch * ry * 0.08;
  const eyeDX = rx * (0.36 - Math.abs(f.yaw) * 0.04);
  const eyeOpen = Math.max(0.08, 1 - f.blink * 0.94);

  for (const sign of [-1, 1]) {
    const eye = add(center, add(mul(xAxis, sign * eyeDX + f.yaw * rx * 0.11), mul(yAxis, eyeY)));
    const ew = rx * 0.19;
    const eh = ry * 0.065 * eyeOpen;
    const eyeShape = [
      add(eye, mul(xAxis, -sign * ew)),
      add(eye, add(mul(xAxis, -sign * ew * 0.18), mul(yAxis, -eh))),
      add(eye, mul(xAxis, sign * ew)),
      add(eye, add(mul(xAxis, sign * ew * 0.18), mul(yAxis, eh))),
    ];
    drawFilledShape(p, eyeShape, '#fffdf4', skinInk, `eye-${sign}`, beat, rx * 0.004);

    const pupil = add(eye, add(mul(xAxis, f.gazeX * ew * 0.28), mul(yAxis, f.gazeY * eh * 0.7)));
    drawBlobEllipse(p, pupil, rx * 0.037, rx * 0.045 * eyeOpen, 0, dna.eye, skinInk, `pupil-${sign}`, beat);

    const browBase = add(eye, mul(yAxis, -ry * (0.13 + wake * 0.035)));
    const browTilt = sign * (0.04 + wake * 0.04) + dna.browTilt;
    drawSoftStroke(
      p,
      [
        add(browBase, add(mul(xAxis, -sign * ew * 0.9), mul(yAxis, browTilt * ry))),
        add(browBase, add(mul(xAxis, sign * ew * 0.85), mul(yAxis, -browTilt * ry * 0.2))),
      ],
      skinInk,
      rx * 0.025,
      `brow-${sign}`,
      beat,
      'round',
    );
  }

  const noseTop = add(center, add(mul(xAxis, f.yaw * rx * 0.24), mul(yAxis, -ry * 0.02 + f.pitch * ry * 0.07)));
  const noseTip = add(center, add(mul(xAxis, f.yaw * rx * 0.34), mul(yAxis, ry * 0.16)));
  const noseWing = add(noseTip, mul(xAxis, rx * (0.08 + f.yaw * 0.03)));
  drawSoftStroke(p, [noseTop, noseTip, noseWing], colorWithAlpha(ink, 0.56), rx * 0.018, 'nose', beat, 'round');

  const cheekAlpha = 0.2 + wake * 0.16;
  drawBlobEllipse(p, add(center, add(mul(xAxis, -rx * 0.43), mul(yAxis, ry * 0.19))), rx * 0.115, ry * 0.055, 0, colorWithAlpha(dna.cheek, cheekAlpha), colorWithAlpha(ink, 0), 'cheek-l', beat);
  drawBlobEllipse(p, add(center, add(mul(xAxis, rx * 0.43), mul(yAxis, ry * 0.19))), rx * 0.115, ry * 0.055, 0, colorWithAlpha(dna.cheek, cheekAlpha), colorWithAlpha(ink, 0), 'cheek-r', beat);

  const mouthY = ry * (0.36 + f.pitch * 0.05);
  const mouthW = rx * (0.22 + wake * 0.05);
  const open = f.mouthOpen * ry * 0.16;
  const smile = dna.smile + wake * 0.06;
  const mouth = [
    add(center, add(mul(xAxis, -mouthW), mul(yAxis, mouthY - smile * ry))),
    add(center, add(mul(xAxis, -mouthW * 0.25), mul(yAxis, mouthY + open * 0.25))),
    add(center, add(mul(xAxis, 0), mul(yAxis, mouthY + open + smile * ry))),
    add(center, add(mul(xAxis, mouthW * 0.25), mul(yAxis, mouthY + open * 0.25))),
    add(center, add(mul(xAxis, mouthW), mul(yAxis, mouthY - smile * ry))),
  ];

  if (open > ry * 0.035) {
    const mouthHole = [
      mouth[0],
      mouth[1],
      mouth[2],
      mouth[3],
      mouth[4],
      add(center, add(mul(xAxis, mouthW * 0.45), mul(yAxis, mouthY + open * 0.65))),
      add(center, add(mul(xAxis, -mouthW * 0.45), mul(yAxis, mouthY + open * 0.65))),
    ];
    drawFilledShape(p, mouthHole, '#4b2424', skinInk, 'mouth-open', beat, rx * 0.003);
  } else {
    drawSoftStroke(p, mouth, skinInk, rx * 0.026, 'mouth-line', beat, 'round');
  }

  if (dna.hasFreckles) {
    for (let i = 0; i < 13; i++) {
      const r = seededUnit(dna.seed, `freckle-${i}`, 0, 0);
      const side = r < 0.5 ? -1 : 1;
      const fx = side * rx * (0.16 + seededUnit(dna.seed, `freckle-x-${i}`, 0, 0) * 0.32);
      const fy = ry * (0.08 + seededUnit(dna.seed, `freckle-y-${i}`, 0, 0) * 0.25);
      const pos = add(center, add(mul(xAxis, fx), mul(yAxis, fy)));
      drawBlobEllipse(p, pos, rx * 0.012, rx * 0.009, now * 0.0, colorWithAlpha(ink, 0.26), colorWithAlpha(ink, 0), `freckle-${i}`, beat);
    }
  }
}

function drawSoftStroke(p, points, strokeColor, weight, trace, beat, cap = 'round', under = false) {
  const wobbled = wobblePolyline(points, trace, beat, Math.max(0.35, weight * (under ? 0.025 : 0.018)));
  const ctx = p.drawingContext;
  p.push();
  ctx.lineJoin = 'round';
  ctx.lineCap = cap;
  p.noFill();
  p.stroke(strokeColor);
  p.strokeWeight(weight);
  p.beginShape();
  if (wobbled.length === 2) {
    p.vertex(wobbled[0].x, wobbled[0].y);
    p.vertex(wobbled[1].x, wobbled[1].y);
  } else {
    p.curveVertex(wobbled[0].x, wobbled[0].y);
    for (const pt of wobbled) p.curveVertex(pt.x, pt.y);
    p.curveVertex(wobbled[wobbled.length - 1].x, wobbled[wobbled.length - 1].y);
  }
  p.endShape();

  if (!under && weight < 12) {
    const shadow = wobblePolyline(points, `${trace}~`, beat, Math.max(0.25, weight * 0.03));
    p.stroke(colorWithAlpha(strokeColor, 0.28));
    p.strokeWeight(weight * 0.52);
    p.beginShape();
    if (shadow.length === 2) {
      p.vertex(shadow[0].x, shadow[0].y);
      p.vertex(shadow[1].x, shadow[1].y);
    } else {
      p.curveVertex(shadow[0].x, shadow[0].y);
      for (const pt of shadow) p.curveVertex(pt.x, pt.y);
      p.curveVertex(shadow[shadow.length - 1].x, shadow[shadow.length - 1].y);
    }
    p.endShape();
  }
  p.pop();
}

function drawFilledShape(p, points, fillColor, outlineColor, trace, beat, wobble = 1.2) {
  const wobbled = wobblePolyline(points, trace, beat, wobble, true);
  p.push();
  p.noStroke();
  p.fill(fillColor);
  p.beginShape();
  for (const pt of wobbled) p.vertex(pt.x, pt.y);
  p.endShape(p.CLOSE);
  if (!isTransparent(outlineColor)) {
    p.noFill();
    p.stroke(outlineColor);
    p.strokeWeight(Math.max(1.2, wobble * 1.8));
    p.beginShape();
    for (const pt of wobbled) p.vertex(pt.x, pt.y);
    p.endShape(p.CLOSE);
  }
  p.pop();
}

function drawBlobEllipse(p, center, rx, ry, rotation, fillColor, outlineColor, trace, beat) {
  const points = [];
  const n = 38;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const breathe = 1 + (seededSigned(state.dna.seed, `${trace}-blob`, beat, i) * 0.018);
    const local = { x: Math.cos(a) * rx * breathe, y: Math.sin(a) * ry * breathe };
    points.push(add(center, rotate(local, rotation)));
  }
  drawFilledShape(p, points, fillColor, outlineColor, trace, beat, Math.max(0.7, Math.min(rx, ry) * 0.035));
}

function wobblePolyline(points, trace, beat, amp, closed = false) {
  if (!points || !points.length) return [];
  return points.map((pt, i) => {
    const prev = points[(i - 1 + points.length) % points.length];
    const next = points[(i + 1) % points.length];
    const tangent = !closed && i === 0 ? sub(next, pt) : !closed && i === points.length - 1 ? sub(pt, prev) : sub(next, prev);
    const n = normalize(perp(tangent), { x: 0, y: 1 });
    const along = normalize(tangent, { x: 1, y: 0 });
    const normalJitter = seededSigned(state.dna.seed, trace, beat, i) * amp;
    const alongJitter = seededSigned(state.dna.seed, `${trace}:t`, beat, i) * amp * 0.26;
    return add(pt, add(mul(n, normalJitter), mul(along, alongJitter)));
  });
}

function drawRigOverlay(p, rig) {
  const j = rig.joints;
  const bones = [
    ['head', 'neck'],
    ['neck', 'chest'],
    ['chest', 'pelvis'],
    ['shoulderL', 'shoulderR'],
    ['hipL', 'hipR'],
    ['shoulderL', 'elbowL'],
    ['elbowL', 'wristL'],
    ['shoulderR', 'elbowR'],
    ['elbowR', 'wristR'],
    ['hipL', 'kneeL'],
    ['kneeL', 'ankleL'],
    ['ankleL', 'footL'],
    ['hipR', 'kneeR'],
    ['kneeR', 'ankleR'],
    ['ankleR', 'footR'],
  ];

  p.push();
  p.strokeWeight(2);
  p.stroke(198, 95, 70, 145);
  for (const [a, b] of bones) {
    if (!j[a] || !j[b]) continue;
    p.line(j[a].x, j[a].y, j[b].x, j[b].y);
  }
  p.noStroke();
  for (const key of Object.keys(j)) {
    const pt = j[key];
    if (!pt) continue;
    p.fill(key === state.manual.selected ? '#211915' : '#c65f46');
    p.circle(pt.x, pt.y, key === state.manual.selected ? 10 : 6);
  }
  if (state.mode === 'manual' && state.pointer.active) {
    p.noFill();
    p.stroke(33, 25, 21, 150);
    p.strokeWeight(1.5);
    p.circle(state.pointer.x, state.pointer.y, 28);
  }
  p.pop();
}

function drawCanvasHud(p, rig) {
  const label = state.mode === 'manual' ? `Mouse target: ${TARGET_LABELS[state.manual.selected]}` : mediaHudLabel(rig);
  p.push();
  p.noStroke();
  p.fill(255, 250, 240, 220);
  p.rect(16, p.height - 54, Math.min(p.width - 32, 500), 38, 18);
  p.fill(33, 25, 21, 220);
  p.textFont('ui-sans-serif, system-ui, sans-serif');
  p.textSize(13);
  p.text(`${state.mode === 'manual' ? 'Manual rig' : 'MediaPipe rig'} · ${label}`, 32, p.height - 31);
  p.pop();
}

function mediaHudLabel(rig) {
  if (state.media.status === 'running' && state.media.landmarks) {
    return `${Math.round((rig.confidence || 0) * 100)}% pose confidence · ${state.media.usingDelegate}`;
  }
  if (state.media.loading) return 'loading model / waiting for permission';
  if (state.media.status === 'error') return 'camera unavailable, using fallback pose';
  return 'click Start camera';
}

function drawPaper(p) {
  p.background('#f7f2e8');
  p.push();
  p.noStroke();
  for (const dot of state.paperDots) {
    p.fill(dot.dark ? 'rgba(95,72,52,0.055)' : 'rgba(255,255,255,0.22)');
    p.circle(dot.x, dot.y, dot.r);
  }
  p.stroke(82, 60, 42, 16);
  p.strokeWeight(1);
  const gap = 34;
  for (let y = -20; y < p.height + 20; y += gap) {
    p.line(0, y + Math.sin(y * 0.02) * 2, p.width, y + Math.sin(y * 0.023 + 1) * 2);
  }
  p.pop();
}

function drawVideoGhost(p) {
  const video = ui.video;
  if (!video || video.readyState < 2) return;
  const ctx = p.drawingContext;
  ctx.save();
  ctx.globalAlpha = 0.16;
  if (state.options.mirrorVideo) {
    ctx.translate(p.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, p.width, p.height);
  ctx.restore();
}

function regeneratePaper(p) {
  const count = Math.floor((p.width * p.height) / 5200);
  const rng = mulberry32(0xdecafbad);
  state.paperDots = Array.from({ length: count }, () => ({
    x: rng() * p.width,
    y: rng() * p.height,
    r: 0.6 + rng() * 1.8,
    dark: rng() > 0.38,
  }));
}

function wireControls() {
  ui.modeButtons.forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  ui.targetButtons.forEach((button) => {
    button.addEventListener('click', () => setManualTarget(button.dataset.target));
  });

  ui.startCamera.addEventListener('click', async () => {
    setMode('mediapipe');
    await startMediaPipe();
  });

  ui.seedInput.addEventListener('change', () => reseed(ui.seedInput.value));
  ui.seedInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') ui.seedInput.blur();
  });
  ui.reroll.addEventListener('click', () => {
    const label = `javascript-friend-${Math.floor(Math.random() * 99999)}`;
    ui.seedInput.value = label;
    reseed(label);
  });

  ui.followMouse.addEventListener('change', () => (state.options.followMouse = ui.followMouse.checked));
  ui.showRig.addEventListener('change', () => (state.options.showRig = ui.showRig.checked));
  ui.showVideo.addEventListener('change', () => (state.options.showVideo = ui.showVideo.checked));
  ui.mirrorVideo.addEventListener('change', () => (state.options.mirrorVideo = ui.mirrorVideo.checked));
  ui.smoothLive.addEventListener('change', () => (state.options.smoothLive = ui.smoothLive.checked));

  window.addEventListener('keydown', (event) => {
    if (isTextInput(event.target)) return;
    const key = event.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) event.preventDefault();
    state.keys.add(key);
    if (key === '1') setManualTarget('leftWrist');
    if (key === '2') setManualTarget('rightWrist');
    if (key === '3') setManualTarget('leftAnkle');
    if (key === '4') setManualTarget('rightAnkle');
    if (key === '5' || key === 'h') setManualTarget('head');
    if (key === 'p') resetManualRig();
    if (key === 'b') triggerBlink();
    if (key === 'm') triggerTalk();
  }, { passive: false });

  window.addEventListener('keyup', (event) => {
    state.keys.delete(event.key.toLowerCase());
  });
}

function setMode(mode) {
  state.mode = mode;
  state.liveRig = null;
  ui.modeButtons.forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  ui.startCamera.classList.toggle('hidden', mode !== 'mediapipe' || state.media.status === 'running');
  if (mode === 'manual') {
    setStatus('Manual rig ready. Move the cursor and press 1–5.');
  } else if (state.media.status === 'running') {
    setStatus('MediaPipe live. Stand back so shoulders, hips, knees, and ankles are visible.');
  } else {
    setStatus('MediaPipe selected. Click Start camera, then allow webcam access.');
  }
}

function setManualTarget(target) {
  state.manual.selected = target;
  ui.targetButtons.forEach((button) => button.classList.toggle('active', button.dataset.target === target));
}

function reseed(seedText) {
  state.dna = createDNA(seedText || 'javascript-friend');
  state.liveRig = null;
}

function resetManualRig() {
  state.manual = createManualState();
  setManualTarget('rightWrist');
  setStatus('Manual pose reset.');
}

function triggerBlink() {
  const now = state.now || performance.now() / 1000;
  state.manual.blinkStarted = now;
  state.manual.blinkUntil = now + 0.16;
}

function triggerTalk() {
  const now = state.now || performance.now() / 1000;
  state.manual.talkUntil = now + 1.45;
}

function updateKeyboardRig(dt) {
  const m = state.manual;
  const keys = state.keys;
  const right = pressed('d') || pressed('arrowright');
  const left = pressed('a') || pressed('arrowleft');
  const up = pressed('w') || pressed('arrowup');
  const down = pressed('s') || pressed('arrowdown');
  const fast = pressed('shift');
  const speed = (fast ? 0.52 : 0.31) * dt;

  const x = (right ? 1 : 0) - (left ? 1 : 0);
  const y = (down ? 1 : 0) - (up ? 1 : 0);
  m.moveX = x;
  m.moveY = y;

  m.rootN.x = clamp(m.rootN.x + x * speed, 0.16, 0.84);
  m.rootN.y = clamp(m.rootN.y + y * speed, 0.36, 0.77);

  const leanTarget = ((pressed('e') ? 1 : 0) - (pressed('q') ? 1 : 0)) + x * 0.38;
  m.lean += (clamp(leanTarget, -1, 1) - m.lean) * (1 - Math.exp(-dt * 7));
  const crouchTarget = pressed('c') || pressed('control') ? 1 : 0;
  m.crouch += (crouchTarget - m.crouch) * (1 - Math.exp(-dt * 9));
  const jumpTarget = pressed(' ') ? 1 : 0;
  m.jump += (jumpTarget - m.jump) * (1 - Math.exp(-dt * 12));
  m.mouthPulse = Math.max(0, m.mouthPulse - dt * 2.8);

  const moveAmount = Math.min(1, Math.hypot(x, y));
  if (moveAmount > 0.01 || m.jump > 0.1) {
    m.gait += dt * (5.2 + moveAmount * 4.8 + m.jump * 2.2);
  }

  function pressed(key) {
    return keys.has(key);
  }
}

async function startMediaPipe() {
  if (state.media.loading || state.media.status === 'running') return;
  state.media.loading = true;
  ui.startCamera.disabled = true;
  setStatus('Loading MediaPipe Pose model…');

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('getUserMedia is unavailable in this browser.');
    }

    const vision = await import(MEDIAPIPE_BUNDLE);
    const filesetResolver = await vision.FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);

    let landmarker;
    let delegate = 'GPU';
    try {
      landmarker = await vision.PoseLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.45,
        minPosePresenceConfidence: 0.45,
        minTrackingConfidence: 0.45,
      });
    } catch (gpuError) {
      console.warn('MediaPipe GPU delegate failed, falling back to CPU.', gpuError);
      delegate = 'CPU';
      landmarker = await vision.PoseLandmarker.createFromOptions(filesetResolver, {
        baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.45,
        minPosePresenceConfidence: 0.45,
        minTrackingConfidence: 0.45,
      });
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user',
      },
    });

    ui.video.srcObject = stream;
    await ui.video.play();

    state.media.landmarker = landmarker;
    state.media.usingDelegate = delegate;
    state.media.status = 'running';
    state.media.loading = false;
    ui.startCamera.disabled = false;
    ui.startCamera.classList.add('hidden');
    setStatus('MediaPipe live. Stand back so your full body is in frame.');
    detectPoseLoop();
  } catch (error) {
    console.error(error);
    state.media.status = 'error';
    state.media.loading = false;
    ui.startCamera.disabled = false;
    ui.startCamera.classList.remove('hidden');
    setStatus(`Camera/MediaPipe failed: ${error.message}. Manual fallback remains active.`);
  }
}

function detectPoseLoop() {
  cancelAnimationFrame(state.media.raf);

  const loop = () => {
    const { landmarker } = state.media;
    const video = ui.video;
    if (!landmarker || !video || state.media.status !== 'running') return;

    if (video.readyState >= 2 && video.currentTime !== state.media.lastVideoTime) {
      const started = performance.now();
      const result = landmarker.detectForVideo(video, started);
      state.media.lastDetectMs = performance.now() - started;
      state.media.lastVideoTime = video.currentTime;
      if (result.landmarks && result.landmarks[0]) {
        state.media.landmarks = result.landmarks[0];
        state.media.worldLandmarks = result.worldLandmarks?.[0] || null;
      }
    }

    state.media.raf = requestAnimationFrame(loop);
  };

  state.media.raf = requestAnimationFrame(loop);
}

function landmarkPoint(p, landmark, minVis, fallback = null) {
  if (!landmark) return fallback;
  const score = landmark.visibility ?? landmark.presence ?? 1;
  if (score < minVis) return fallback;
  const x = state.options.mirrorVideo ? (1 - landmark.x) * p.width : landmark.x * p.width;
  return { x, y: landmark.y * p.height, z: landmark.z || 0, score };
}

function inferHead(nose, earMid, neck, up, unit) {
  if (earMid && nose) {
    return { x: (earMid.x * 0.55 + nose.x * 0.45), y: (earMid.y * 0.55 + nose.y * 0.45) - unit * 0.04 };
  }
  if (nose) return add(nose, mul(up, unit * 0.06));
  return add(neck, mul(up, unit * 0.45));
}

function blendRig(a, b, alpha) {
  const joints = {};
  for (const key of Object.keys(b.joints)) {
    joints[key] = a.joints[key] ? lerpPoint(a.joints[key], b.joints[key], alpha) : b.joints[key];
  }
  const face = {};
  for (const key of Object.keys(b.face)) {
    face[key] = typeof b.face[key] === 'number' && typeof a.face[key] === 'number' ? lerp(a.face[key], b.face[key], alpha) : b.face[key];
  }
  return {
    ...b,
    confidence: lerp(a.confidence || 0, b.confidence || 0, alpha),
    unit: lerp(a.unit || b.unit, b.unit, alpha),
    joints,
    face,
  };
}

function refreshStatusOccasionally(now, rig) {
  if (now - state.lastStatusAt < 1) return;
  state.lastStatusAt = now;
  if (state.mode === 'mediapipe') {
    if (state.media.status === 'running' && state.media.landmarks) {
      setStatus(`MediaPipe live: ${Math.round((rig.confidence || 0) * 100)}% pose confidence, ${state.media.lastDetectMs.toFixed(1)} ms detect (${state.media.usingDelegate}).`);
    } else if (state.media.status === 'running') {
      setStatus('Camera is running; looking for a person. Step back until the whole body is visible.');
    }
  }
}

function setStatus(message) {
  ui.status.textContent = message;
}

function createManualState() {
  return {
    rootN: { x: 0.54, y: 0.58 },
    selected: 'rightWrist',
    lean: 0,
    crouch: 0,
    jump: 0,
    gait: 0,
    moveX: 0,
    moveY: 0,
    blinkStarted: -99,
    blinkUntil: -99,
    talkUntil: -99,
    mouthPulse: 0,
  };
}

function createDNA(seedText) {
  const seed = hashString(String(seedText || 'javascript-friend'));
  const rng = mulberry32(seed);
  const skinPalettes = ['#f2c6a2', '#d99b75', '#a86f55', '#744f3f', '#f6d7bf', '#c48768'];
  const hairPalettes = ['#211915', '#513728', '#8a5c35', '#c98242', '#d8d1bc', '#2d2e38', '#703332'];
  const shirtPalettes = ['#d85f4b', '#466c8f', '#e0a344', '#5f9d7a', '#795c9a', '#2f7775', '#c15e86'];
  const pantsPalettes = ['#28344a', '#42483f', '#6f5b45', '#3f596e', '#22201f', '#696c8f'];
  const eyePalettes = ['#1d2227', '#4a3426', '#395a6a', '#476b42', '#2c2a3f'];
  const hairStyles = ['cap', 'bob', 'curls', 'spikes'];
  const patterns = ['stripe', 'buttons', 'pocket'];

  return {
    seed,
    beatOffset: rng() * 100,
    motionPhase: rng() * Math.PI * 2,
    breathTempo: rng() * 0.45,
    headWide: rng() * 2 - 1,
    headTall: rng() * 2 - 1,
    shoulder: rng() * 2 - 1,
    hip: rng() * 2 - 1,
    torso: rng() * 2 - 1,
    arm: rng() * 2 - 1,
    leg: rng() * 2 - 1,
    browTilt: (rng() * 2 - 1) * 0.035,
    smile: 0.02 + rng() * 0.045,
    hasFreckles: rng() > 0.54,
    hairStyle: pick(hairStyles, rng),
    pattern: pick(patterns, rng),
    skin: pick(skinPalettes, rng),
    hair: pick(hairPalettes, rng),
    shirt: pick(shirtPalettes, rng),
    pants: pick(pantsPalettes, rng),
    eye: pick(eyePalettes, rng),
    cheek: '#e77d70',
    ink: '#211915',
  };
}

function blinkEnvelope(start, end, now) {
  if (now < start || now > end) return 0;
  const t = (now - start) / Math.max(0.001, end - start);
  return Math.sin(Math.PI * clamp(t, 0, 1));
}

function idleBlink(now, dna) {
  const cycle = 3.2 + (dna.seed % 17) * 0.09;
  const phase = ((now + dna.motionPhase) % cycle) / cycle;
  if (phase > 0.05) return 0;
  return Math.sin((phase / 0.05) * Math.PI);
}

function chatter(now, dna) {
  const syllable = 0.5 + 0.5 * Math.sin(now * (14 + (dna.seed % 7)) + dna.motionPhase);
  const stress = 0.68 + 0.32 * Math.sin(now * 5.1 + 1.4);
  return syllable * stress;
}

function centerPointer(p) {
  state.pointer.x = p.width * 0.64;
  state.pointer.y = p.height * 0.38;
  state.pointer.active = false;
}

function updatePointer(p, down) {
  state.pointer.x = p.mouseX;
  state.pointer.y = p.mouseY;
  state.pointer.active = p.mouseX >= 0 && p.mouseX <= p.width && p.mouseY >= 0 && p.mouseY <= p.height;
  state.pointer.down = down;
  state.pointer.lastMove = performance.now();
}

function isTextInput(target) {
  return target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function isTransparent(color) {
  return typeof color === 'string' && (color.includes('rgba') && color.includes(', 0)'));
}

function mediaScore(point) {
  return typeof point?.score === 'number' ? point.score : 0.75;
}

function averageScore(points) {
  const valid = points.filter(Boolean);
  if (!valid.length) return 0;
  return valid.reduce((sum, point) => sum + mediaScore(point), 0) / valid.length;
}

function solveTwoBone(base, target, lenA, lenB, bendSign = 1) {
  const toTarget = sub(target, base);
  const dRaw = length(toTarget) || 0.0001;
  const d = clamp(dRaw, Math.abs(lenA - lenB) + 0.001, lenA + lenB - 0.001);
  const dir = mul(toTarget, 1 / dRaw);
  const a = (lenA * lenA - lenB * lenB + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, lenA * lenA - a * a));
  return add(base, add(mul(dir, a), mul(perp(dir), h * bendSign)));
}

function clampReach(base, target, maxLen) {
  const delta = sub(target, base);
  const d = length(delta);
  if (d <= maxLen || d === 0) return { x: target.x, y: target.y };
  return add(base, mul(delta, maxLen / d));
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function mul(a, scalar) {
  return { x: a.x * scalar, y: a.y * scalar };
}

function avg(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, score: ((a.score ?? 1) + (b.score ?? 1)) / 2 };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function length(a) {
  return Math.hypot(a.x, a.y);
}

function normalize(a, fallback = { x: 1, y: 0 }) {
  const d = length(a);
  return d > 0.00001 ? { x: a.x / d, y: a.y / d } : fallback;
}

function perp(a) {
  return { x: -a.y, y: a.x };
}

function rotate(v, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpPoint(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), score: lerp(a.score ?? 1, b.score ?? 1, t) };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function colorWithAlpha(color, alpha) {
  if (alpha >= 0.999) return color;
  if (color.startsWith('rgba')) return color.replace(/rgba\(([^)]+),\s*[^,)]+\)/, `rgba($1, ${alpha})`);
  const { r, g, b } = hexToRgb(color);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '').trim();
  const n = Number.parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function pick(items, rng) {
  return items[Math.floor(rng() * items.length) % items.length];
}

function seededSigned(seed, trace, beat, index) {
  return seededUnit(seed, trace, beat, index) * 2 - 1;
}

function seededUnit(seed, trace, beat, index) {
  const stable = hashString(`${seed}:${trace}:${index}:hand`);
  const boiling = hashString(`${seed}:${trace}:${beat}:${index}:beat`);
  const a = mulberry32(stable)();
  const b = mulberry32(boiling)();
  return clamp(a * 0.62 + b * 0.38, 0, 1);
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function rand() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
