export interface AngularInput {
  yawRate: number
  pitchRate: number
  rollInput: number
}

function clamp(value: number): number {
  return Math.max(-1, Math.min(1, value))
}

export function resolveKeyboardAngularInput(keys: ReadonlySet<string>): AngularInput {
  return {
    yawRate: (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0),
    pitchRate: (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0),
    rollInput: (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0),
  }
}

export function resolveMouseAngularInput(mouseDx: number, mouseDy: number, deltaSeconds: number, sensitivity = 1): AngularInput {
  const dt = Math.max(deltaSeconds, 0.016)
  return {
    yawRate: clamp(mouseDx * 0.003 * sensitivity / dt),
    pitchRate: clamp(-mouseDy * 0.003 * sensitivity / dt),
    rollInput: 0,
  }
}

export function combineAngularInput(keyboard: AngularInput, mouse: AngularInput): AngularInput {
  return {
    yawRate: clamp(keyboard.yawRate + mouse.yawRate),
    pitchRate: clamp(keyboard.pitchRate + mouse.pitchRate),
    rollInput: keyboard.rollInput,
  }
}
