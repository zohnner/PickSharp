const STORAGE_KEY = 'sharp_buyer_token';

let memoryToken = null;

export function getBuyerToken() {
  try {
    let token = localStorage.getItem(STORAGE_KEY);
    if (!token) {
      token = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEY, token);
    }
    return token;
  } catch {
    if (!memoryToken) {
      memoryToken = crypto.randomUUID();
    }
    return memoryToken;
  }
}
