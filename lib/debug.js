'use strict';

let report = false;

module.exports.enable = () => (report = true);
module.exports.disable = () => (report = false);

for (let method in console) {
  module.exports[method] = (...args) => {
    if (report) {
      return console[method](...args);
    }
  };
}
