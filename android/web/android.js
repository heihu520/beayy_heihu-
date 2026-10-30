// 安卓外壳：和 Tauri 一样的调用方式（window.__TAURI__.core.invoke），网页代码不用改。
// 请求经 beayyAndroid.invoke 交给 Kotlin（MainActivity.Bridge），结果由 window.__beayyResolve 送回
(function () {
  let n = 0; const pending = {};
  window.__beayyResolve = function (id, res) {
    const p = pending[id]; if (!p) return; delete pending[id];
    if (res && Object.prototype.hasOwnProperty.call(res, "err")) p.reject(res.err); else p.resolve(res ? res.ok : null);
  };
  window.__TAURI__ = { core: { invoke: function (cmd, args) {
    return new Promise(function (resolve, reject) {
      const id = ++n; pending[id] = { resolve: resolve, reject: reject };
      window.beayyAndroid.invoke(id, cmd, JSON.stringify(args || {}));
    });
  } } };
})();
