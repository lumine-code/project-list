function createGlobLoader(importGlob = () => import("tinyglobby")) {
  let pending;
  return function loadGlob() {
    pending ||= Promise.resolve()
      .then(importGlob)
      .catch((error) => {
        pending = null;
        throw error;
      });
    return pending;
  };
}

module.exports = { createGlobLoader, loadGlob: createGlobLoader() };
