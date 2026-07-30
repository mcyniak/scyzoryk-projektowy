const fs = require('fs');
const path = require('path');

function hasDependencies(appDir, dependencies) {
  for (const dependency of dependencies) {
    const dependencyDir = path.join(appDir, 'node_modules', ...dependency.split('/'));
    if (!fs.existsSync(dependencyDir)) return false;
  }
  return true;
}

module.exports = { hasDependencies };
