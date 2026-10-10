/** The part of react-native the SDK uses: AppState. */
type Listener = (state: string) => void;

const scope = globalThis as any;

function listeners(): Set<Listener> {
  if (!scope.__riviumTestAppState) scope.__riviumTestAppState = new Set<Listener>();
  return scope.__riviumTestAppState;
}

export const AppState = {
  addEventListener(_type: string, listener: Listener) {
    listeners().add(listener);
    return { remove: () => listeners().delete(listener) };
  },
};

/** What the operating system does when the app goes to the background or returns. */
export function setAppState(state: string): void {
  [...listeners()].forEach((listener) => listener(state));
}

export function appStateListeners(): number {
  return listeners().size;
}
