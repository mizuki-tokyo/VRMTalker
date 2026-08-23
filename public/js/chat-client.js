/**
 * /api/chat のクライアント。
 *
 * 応答は Server-Sent Events で少しずつ届く。文が完成した時点で順に返すことで、
 * 生成の完了を待たずに音声合成へ回せる（最初の発話までの待ち時間が短くなる）。
 */

import splitSentence from "./split-sentence.js";

// モデルが稀に出力する特殊トークン。そのまま読み上げさせないため取り除く
// 例: <|tool_call_start|>[voice_read()]<|tool_call_end|>
const SPECIAL_TOKEN_PATTERN = /<\|[^|]*\|>/g;

const sanitize = (text) => {
    return text.replace(SPECIAL_TOKEN_PATTERN, "").trim();
};

class ChatClient {

    _endpoint = "/api/chat";

    // やりとりの履歴。サーバへ直近ぶんを送って文脈を保つ
    _history = [];
    _maxHistory = 10;

    // キャラクタ像。サーバがこれをシステムプロンプトに組み込む。
    // 音声で読み上げるための制約はサーバ側が持つので、ここでは上書きできない
    _persona = {name: "", profile: ""};

    set endpoint(value) { this._endpoint = value; }
    get endpoint() { return this._endpoint; }

    set persona({name = "", profile = ""} = {}) {
        this._persona = {name, profile};
    }
    get persona() { return {...this._persona}; }

    get history() { return [...this._history]; }

    clearHistory() {
        this._history = [];
    }

    /**
     * 応答文を「文」単位で順に返す非同期イテレータ。
     *
     *   for await (const sentence of chatClient.stream(text)) { ... }
     *
     * @param {string} text ユーザーの発話
     * @param {(delta: string) => void} [onDelta] 差分ごとの通知（画面表示用）
     */
    async *stream(text, onDelta) {
        const response = await fetch(this._endpoint, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                text,
                history: this._history,
                persona: this._persona
            })
        });

        if (! response.ok) {
            const detail = await response.json().catch(() => null);
            throw new Error(detail?.detail || `応答の生成に失敗しました (${response.status})`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let buffer = "";      // SSE の行バッファ
        let pending = "";     // まだ文として確定していないテキスト
        let full = "";        // 応答全体（履歴に積む）

        try {
            while (true) {
                const {done, value} = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, {stream: true});

                // SSE は "\n\n" 区切り
                const events = buffer.split("\n\n");
                buffer = events.pop();

                for (const event of events) {
                    const line = event.split("\n").find((l) => l.startsWith("data:"));
                    if (! line) {
                        continue;
                    }
                    const data = line.slice("data:".length).trim();
                    if (data === "[DONE]") {
                        continue;
                    }

                    const chunk = JSON.parse(data);
                    if (chunk.error) {
                        throw new Error(chunk.error);
                    }
                    if (! chunk.delta) {
                        continue;
                    }

                    pending += chunk.delta;
                    full += chunk.delta;
                    if (onDelta) {
                        onDelta(chunk.delta);
                    }

                    // 完成した文から順に返す
                    const sentences = splitSentence(pending);
                    pending = sentences.pop() ?? "";
                    for (const sentence of sentences) {
                        const cleaned = sanitize(sentence);
                        if (cleaned) {
                            yield cleaned;
                        }
                    }
                }
            }

            // 区切り文字で終わらなかった残り
            const rest = sanitize(pending);
            if (rest) {
                yield rest;
            }

        } finally {
            reader.cancel().catch(() => {});
        }

        this._pushHistory(text, full);
    }

    _pushHistory(userText, assistantText) {
        this._history.push({role: "user", content: userText});
        if (assistantText) {
            this._history.push({role: "assistant", content: assistantText});
        }
        // 直近のやりとりのみ保持する
        this._history = this._history.slice(-this._maxHistory * 2);
    }
}

export default ChatClient;
