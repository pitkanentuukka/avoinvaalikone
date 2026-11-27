// A stand-in for React's hooks, bundled in place of "react" for App.jsx only
// (see tests/unit/adminErrorClears.test.js). It lets a component be called as
// a plain function and its event handlers run without a DOM: each call to
// `render()` returns the element tree the component would hand to React, and
// state set by a handler is there on the next `render()`. Child components are
// not called, so only the component's own hooks need to work.
let slots = [];
let index = 0;
let contextValue;

export function createContext(defaultValue) {
  return { defaultValue, Provider: "Provider" };
}

export function useContext(context) {
  return contextValue ?? context.defaultValue;
}

export function useState(initial) {
  const i = index++;
  if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
  return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
}

export function useRef(initial) {
  const i = index++;
  if (!(i in slots)) slots[i] = { current: initial };
  return slots[i];
}

function unsupported(name) {
  return () => { throw new Error(`fakeHooks: ${name} is not implemented`); };
}
export const useEffect = unsupported("useEffect");
export const useMemo = unsupported("useMemo");
export const useId = unsupported("useId");

export const harness = {
  // Forget all state, as a fresh mount would.
  mount(context) {
    slots = [];
    contextValue = context;
  },
  render(Component, props = {}) {
    index = 0;
    return Component(props);
  },
};
