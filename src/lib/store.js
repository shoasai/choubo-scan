// PoC (アーティファクト版) の window.storage 互換の localStorage ラッパー
const PREFIX = "choubo:";

export const appStorage = {
  async get(key) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v === null ? null : { value: v };
    } catch {
      return null;
    }
  },
  async set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, value);
    } catch {}
  },
};
