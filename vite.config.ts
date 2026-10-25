import { defineConfig } from "vite";

// Cloud Functions エミュレーター上の位置API（npm run emulators で起動）
const LOCATION_FUNCTION_URL =
  "http://127.0.0.1:5001/localweather-forecast/asia-northeast1/location";

export default defineConfig({
  server: {
    // 別のPCのブラウザから 192.168.1.68 で開けるようにする
    host: true,
    proxy: {
      "/api/location": {
        target: LOCATION_FUNCTION_URL,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/location/, ""),
      },
    },
  },
});
