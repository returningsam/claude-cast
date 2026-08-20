// Minimal @raycast/api stand-in so the module can run outside Raycast.
export class Cache {
  get() { return undefined }
  set() {}
}
export function getPreferenceValues() {
  return { oauthToken: "test-token" };
}
