import base from "@lorenzh/pulse-config/eslint.config.js";

// .repos/ holds read-only clones of other repositories in the Factory runner.
export default [{ ignores: [".repos/**"] }, ...base];
