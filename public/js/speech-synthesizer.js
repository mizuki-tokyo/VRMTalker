/**
 * ローカルの VOICEVOX CORE で音声合成を行う。
 *
 * 合成はサーバ側（FastAPI の /api/tts）で実行する。ブラウザから直接
 * 合成エンジンを叩かないことで、CORS も HTTPS 混在も考えずに済む。
 *
 * 生成した音声を利用する際は VOICEVOX のクレジット表記が必要。
 */
class SpeechSynthesizer {

    _endpoint = "/api/tts";

    // 話者のスタイル ID。既定は「四国めたん（ノーマル）」
    // 利用可能な一覧は GET /api/speakers で取得できる
    _styleId = 2;

    set endpoint(value) { this._endpoint = value; }
    get endpoint() { return this._endpoint; }

    set styleId(value) { this._styleId = value; }
    get styleId() { return this._styleId; }

    /** 利用可能なキャラクターとスタイルの一覧を取得する。 */
    async getSpeakers() {
        const response = await fetch("/api/speakers");
        if (! response.ok) {
            throw new Error(`話者一覧の取得に失敗しました (${response.status})`);
        }
        return response.json();
    }

    /**
     * テキストを音声合成する。
     * @param {string} text
     * @returns {Promise<ArrayBuffer>} WAV データ
     */
    async createSound(text) {
        let response;
        try {
            response = await fetch(this._endpoint, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({text, style_id: this._styleId})
            });
        } catch (error) { // network error
            throw new Error("音声合成サーバに接続できませんでした");
        }

        if (! response.ok) {
            // FastAPI は {"detail": "..."} を返す
            const detail = await response.json().catch(() => null);
            throw new Error(detail?.detail || `音声合成に失敗しました (${response.status})`);
        }
        return response.arrayBuffer();
    }
}

export default SpeechSynthesizer;
