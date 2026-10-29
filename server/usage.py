"""官方服务的用量：转写（音频秒）和地图（次）记进同步服务的库（syncapi.add_usage）。
转写进程（worker.py）和接口在同一台机器、挂同一个 data/sync，直接写库。"""
import threading
import time

import syncapi


def report(user: str, service: str, n: float, log=print):
    """记这个账号用了多少；失败只记日志，不影响服务本身"""
    try:
        syncapi.add_usage(user, service, n)
    except Exception as e:
        log(f"记用量失败：{e!r}")


class Counter:
    """地图这种一次一次的：先在内存里攒着，每 30 秒报一次"""

    def __init__(self, service: str):
        self.service, self.lock, self.counts = service, threading.Lock(), {}
        threading.Thread(target=self._loop, daemon=True).start()

    def add(self, user: str, n: int = 1):
        with self.lock:
            self.counts[user] = self.counts.get(user, 0) + n

    def _loop(self):
        while True:
            time.sleep(30)
            with self.lock:
                batch, self.counts = self.counts, {}
            for user, n in batch.items():
                report(user, self.service, n)
