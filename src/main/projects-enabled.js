'use strict';

// Projects are part of the normal v1 experience; the explicit value "0" is the opt-out.
function projectsEnabled(env = process.env) {
  return env.CONTEXTDECK_PROJECTS !== '0';
}

module.exports = { projectsEnabled };
