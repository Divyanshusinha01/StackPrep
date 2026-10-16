import type { DeviceError } from "@/components/app/use-device-check";

/** Lobby device-check failures. */
export const DEVICE_ERRORS: Record<DeviceError, string> = {
  denied: "Camera or microphone access was blocked. Allow access in your browser settings and try again.",
  not_found: "No camera or microphone was found. Connect one and try again.",
  unsupported: "This browser cannot access a camera and microphone. Use a recent desktop browser.",
  failed: "The camera or microphone stopped working. Check your devices and try again.",
};

/** The same failures once the live room is open, where the fix is to reconnect. */
export const DEVICE_ROOM_ERRORS = {
  microphone_denied: "Camera or microphone access was blocked. Allow access in your browser settings and reconnect.",
  microphone_unavailable: "No working camera or microphone was found. Connect them and reconnect.",
} as const;
