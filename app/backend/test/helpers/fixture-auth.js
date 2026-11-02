const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise production header/cookie parsing without connecting to an account store.
function createFixtureAuth(getUser) {
  const filename = path.resolve(__dirname, '../../middleware/auth.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, process,
    require(name) {
      if (name !== '../services/auth') throw new Error(`Unexpected authentication dependency: ${name}`);
      return { requireUser: async token => {
        if (token !== 'fixture') throw new Error('UNAUTHORIZED');
        return getUser();
      } };
    },
  }, { filename });
  return module.exports;
}

module.exports = { createFixtureAuth };
