"""转写用的模型和一段音频的处理（worker.py 用）。

切分：FSMN-VAD 按停顿（默认 400 毫秒）切成一轮一轮的话，每轮单独转写（Paraformer＋标点＋热词）、单独认人。
说话人：每轮用 CAM++ 算声纹，和本人声纹相似度 ≥ SELF_TH 标本人，否则和当天已出现的他人比，
≥ OTHER_TH 沿用编号，不然新开「他人N」。他人的声纹质心（others）由调用方按天保存、下一段带回来，所以「他人N」只在同一天内一致。
"""
import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

SR = 16000
SELF_TH = float(os.environ.get("BEAYY_SELF_TH", "0.55"))
OTHER_TH = float(os.environ.get("BEAYY_OTHER_TH", "0.60"))
EMB_MAX_SEC = 30
MIN_EMB_SEC = 1.0  # 一轮话不到 1 秒，声纹不可靠，标「未辨」
NEW_SPK_SEC = 2.0  # 至少 2 秒的一轮话才新开一个「他人N」，短的「嗯」「明白了」声纹不稳
TURN_SILENCE_MS = int(os.environ.get("BEAYY_TURN_SILENCE_MS", "400"))
MAX_TURN_MS = 30000  # 一个人连着说超过 30 秒也切一刀，模型一次吃不下太长
ASR_BATCH = 8
# 热词：人名、项目名这类模型容易认错的专名，空格分隔，写在 .env 的 BEAYY_HOTWORDS
HOTWORDS = " ".join(os.environ.get("BEAYY_HOTWORDS", "").replace(",", " ").split())


def decode(path: Path) -> np.ndarray:
    """任何格式 → 16k 单声道 float32。"""
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR),
                          "-f", "s16le", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def unit(v) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32).flatten()
    return v / (np.linalg.norm(v) + 1e-9)


class Models:
    def __init__(self, log=print):
        import torch
        from funasr import AutoModel
        torch.set_num_threads(int(os.environ.get("OMP_NUM_THREADS", "8")))
        kw = dict(disable_update=True, device="cpu", disable_pbar=True)
        log("加载 Paraformer＋标点、VAD、CAM++ …")
        self.asr = AutoModel(model="paraformer-zh", punc_model="ct-punc", **kw)
        self.sv = AutoModel(model="cam++", **kw)
        # 停顿超过 TURN_SILENCE_MS 就切开：换人说话一般有停顿，按停顿切出来的一段基本是一个人的一轮话
        self.vad = AutoModel(model="fsmn-vad", max_end_silence_time=TURN_SILENCE_MS,
                             max_single_segment_time=MAX_TURN_MS, **kw)

    def embed(self, audio: np.ndarray) -> np.ndarray:
        r = self.sv.generate(input=audio, extract_embedding=True)
        return unit(r[0]["spk_embedding"])

    def turns(self, audio: np.ndarray) -> list[tuple[int, int]]:
        """人声区间（毫秒）。"""
        r = self.vad.generate(input=audio)
        return [(int(s), int(e)) for s, e in (r[0].get("value") or [])] if r else []

    def text(self, clips: list[np.ndarray]) -> list[str]:
        kw = {"hotword": HOTWORDS} if HOTWORDS else {}
        res = self.asr.generate(input=clips, batch_size=ASR_BATCH, **kw)
        return [(r.get("text") or "").strip() for r in res]

    def speech_only(self, audio: np.ndarray) -> np.ndarray:
        parts = [audio[s * SR // 1000:e * SR // 1000] for s, e in self.turns(audio)]
        return np.concatenate(parts) if parts else audio[:0]

    def voiceprint(self, path: Path) -> tuple[np.ndarray, float]:
        """本人朗读的一段 → (声纹, 人声秒数)；人声少于 5 秒抛 ValueError"""
        speech = self.speech_only(decode(path))
        if len(speech) < SR * 5:
            raise ValueError(f"录音里只有 {len(speech) / SR:.1f} 秒人声，少于 5 秒，请重录")
        return self.embed(speech[:SR * 60]), round(len(speech) / SR, 1)


def label_turns(m: Models, clips, others: list, me, self_name: str):
    """每一轮话认一次人，分两遍：
      1. 至少 NEW_SPK_SEC 秒的长话轮：像本人 → self_name；否则和当天已出现的他人比，像就沿用编号，不像就新开「他人N」
      2. 短话轮（1 秒到 NEW_SPK_SEC 秒）声纹不稳，不新开人：像本人就是本人，否则归给最像的已知他人
    不到 1 秒的、或当天还没有任何他人可归的，标「未辨」。others（[{label, centroid, n}]）就地更新。"""
    embs = [m.embed(c[:SR * EMB_MAX_SEC]) if len(c) >= SR * MIN_EMB_SEC else None for c in clips]
    labels = ["未辨"] * len(clips)

    def nearest(e):
        scored = [(float(e @ np.asarray(o["centroid"], dtype=np.float32)), o) for o in others]
        return max(scored, key=lambda x: x[0]) if scored else (-1.0, None)

    for long_pass in (True, False):
        for i, (clip, e) in enumerate(zip(clips, embs)):
            if e is None or (len(clip) >= SR * NEW_SPK_SEC) != long_pass:
                continue
            if me is not None and float(e @ me) >= SELF_TH:
                labels[i] = self_name
                continue
            score, best = nearest(e)
            if best is not None and (score >= OTHER_TH or not long_pass):
                if long_pass:
                    best.update(centroid=unit(np.asarray(best["centroid"]) * best["n"] + e).tolist(), n=best["n"] + 1)
                labels[i] = best["label"]
            elif long_pass:
                others.append({"label": f"他人{len(others) + 1}", "centroid": e.tolist(), "n": 1})
                labels[i] = others[-1]["label"]
    return labels


def transcribe(m: Models, path: Path, start: datetime, others: list, me, self_name: str, tz=timezone.utc):
    """一段音频 → (句子 [{start, end, speaker, text}], 音频秒数, 人声秒数)。时刻按 tz 写 ISO8601。others 就地更新。"""
    audio = decode(path)
    turns = m.turns(audio) if len(audio) >= SR // 2 else []
    clips = [audio[s * SR // 1000:e * SR // 1000] for s, e in turns]
    texts = m.text(clips) if clips else []
    labels = label_turns(m, clips, others, me, self_name) if clips else []
    utts = []
    for (s, e), text, who in zip(turns, texts, labels):
        if len(text.strip("，。？！、,.?! ")) < 2:  # 空的、「嗯」「啊」这类单字，丢掉
            continue
        utts.append({"start": (start + timedelta(milliseconds=s)).astimezone(tz).isoformat(timespec="seconds"),
                     "end": (start + timedelta(milliseconds=e)).astimezone(tz).isoformat(timespec="seconds"),
                     "speaker": who, "text": text})
    return utts, round(len(audio) / SR, 1), round(sum(e - s for s, e in turns) / 1000, 1)
