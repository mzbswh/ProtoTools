import React, { ChangeEvent, memo, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

// Vite worker import — bundled separately, runs off main thread
import CodecWorker from "./codec.worker?worker";

type ProtoSource = { name: string; content: string };
type OperationMode = "decode" | "encode";
type DecodeInputFormat = "file" | "base64" | "hex";
type DecodeOutputFormat = "pretty-json" | "compact-json" | "proto-text" | "field-table";
type JsonInputFormat = "text" | "file";
type DecodeCompressionMode = "auto" | "gzip" | "raw";
type EncodeCompressionMode = "raw" | "gzip";

type ResultState = {
  status: "idle" | "ok" | "error" | "loading";
  message: string;
  text: string;
  // pretty-json: parsed object for interactive viewer (avoid re-parsing)
  object?: unknown;
  bytes?: Uint8Array;
};

const DEFAULT_PROTO_NAME = "input.proto";
const ARRAY_PAGE_SIZE = 100;

// ---- Worker bridge ----

let workerInstance: Worker | null = null;
let pendingReqId = 0;
const pendingCallbacks = new Map<number, (msg: unknown) => void>();

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new CodecWorker();
    workerInstance.onmessage = (e: MessageEvent) => {
      const { id } = e.data as { id: number };
      const cb = pendingCallbacks.get(id);
      if (cb) { pendingCallbacks.delete(id); cb(e.data); }
    };
    workerInstance.onerror = (e) => {
      // bubble all pending with a generic error (should rarely happen)
      for (const [id, cb] of pendingCallbacks) {
        pendingCallbacks.delete(id);
        cb({ id, ok: false, error: `Worker error: ${e.message}` });
      }
    };
  }
  return workerInstance;
}

function callWorker<T>(msg: object, transfer?: Transferable[]): Promise<T> {
  return new Promise((resolve) => {
    const id = ++pendingReqId;
    pendingCallbacks.set(id, resolve as (v: unknown) => void);
    const worker = getWorker();
    if (transfer?.length) {
      worker.postMessage({ ...msg, id }, transfer);
    } else {
      worker.postMessage({ ...msg, id });
    }
  });
}

// ---- Utilities (main thread only — small, non-blocking) ----

function normalizeProtoName(name: string) {
  return name.replace(/\\/g, "/").split("/").pop() || DEFAULT_PROTO_NAME;
}

function readFileAsText(file: File) { return file.text(); }
function readFileAsBytes(file: File) { return file.arrayBuffer().then((b) => new Uint8Array(b)); }

function base64ToBytes(value: string) {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized) throw new Error("Base64 输入为空。");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function hexToBytes(value: string) {
  const normalized = value.replace(/[\s,_-]+/g, "");
  if (!normalized) throw new Error("Hex 输入为空。");
  if (normalized.length % 2 !== 0) throw new Error("Hex 长度必须是偶数。");
  if (!/^[0-9a-fA-F]+$/.test(normalized)) throw new Error("Hex 只能包含 0-9 / a-f / A-F。");
  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < normalized.length; i += 2) bytes[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
  return bytes;
}

function downloadText(text: string, fileName: string, mimeType: string) {
  if (!text) return;
  downloadBlob(new Blob([text], { type: mimeType }), fileName);
}

function downloadBytes(bytes: Uint8Array | undefined, fileName: string) {
  if (!bytes) return;
  downloadBlob(new Blob([bytes], { type: "application/octet-stream" }), fileName);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = fileName; link.click();
  URL.revokeObjectURL(url);
}

// ---- FileInput ----

function FileInput({ label, accept, multiple, fileName, onChange }: {
  label: string; accept?: string; multiple?: boolean; fileName?: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="field">
      <span>{label}</span>
      <div className="file-input-row">
        <button type="button" className="file-btn" onClick={() => ref.current?.click()}>选择文件</button>
        <span className="file-name-display">{fileName || "未选择文件"}</span>
      </div>
      <input
        ref={ref} type="file" accept={accept} multiple={multiple} className="file-input-hidden"
        onChange={(e) => { onChange(e); e.currentTarget.value = ""; }}
      />
    </div>
  );
}

// ---- JsonViewer ----

function shouldDefaultOpen(value: unknown, depth: number): boolean {
  if (depth >= 2) return false;
  if (Array.isArray(value) && value.length > 30) return false;
  if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length > 30) return false;
  return true;
}

const JsonNode = memo(function JsonNode({ value, depth, isLast }: {
  value: unknown; depth: number; isLast: boolean;
}) {
  const [open, setOpen] = useState(() => shouldDefaultOpen(value, depth));
  const [page, setPage] = useState(1);

  const comma = !isLast && <span className="jv-comma">,</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span><span className="jv-bracket">[]</span>{comma}</span>;
    const visibleCount = page * ARRAY_PAGE_SIZE;
    const visible = value.slice(0, visibleCount);
    const hasMore = visibleCount < value.length;
    return (
      <>
        <button className="jv-toggle" onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"}</button>
        <span className="jv-bracket">[</span>
        {open ? (
          <>
            {visible.map((item, i) => (
              <div key={i} className="jv-indent">
                <JsonNode value={item} depth={depth + 1} isLast={i === visible.length - 1 && !hasMore} />
              </div>
            ))}
            {hasMore && (
              <div className="jv-indent">
                <button className="jv-load-more" onClick={() => setPage((p) => p + 1)}>
                  显示更多（{visibleCount} / {value.length}）…
                </button>
              </div>
            )}
            <div><span className="jv-bracket">]</span>{comma}</div>
          </>
        ) : (
          <>
            <span className="jv-ellipsis" onClick={() => setOpen(true)}> {value.length} items </span>
            <span className="jv-bracket">]</span>{comma}
          </>
        )}
      </>
    );
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span><span className="jv-bracket">{"{}"}</span>{comma}</span>;
    return (
      <>
        <button className="jv-toggle" onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"}</button>
        <span className="jv-bracket">{"{"}</span>
        {open ? (
          <>
            {entries.map(([key, val], i) => (
              <div key={key} className="jv-indent">
                <span className="jv-key">{JSON.stringify(key)}</span>
                <span className="jv-colon">: </span>
                <JsonNode value={val} depth={depth + 1} isLast={i === entries.length - 1} />
              </div>
            ))}
            <div><span className="jv-bracket">{"}"}</span>{comma}</div>
          </>
        ) : (
          <>
            <span className="jv-ellipsis" onClick={() => setOpen(true)}> {entries.length} keys </span>
            <span className="jv-bracket">{"}"}</span>{comma}
          </>
        )}
      </>
    );
  }

  if (value === null) return <><span className="jv-null">null</span>{comma}</>;
  if (typeof value === "string") return <><span className="jv-string">{JSON.stringify(value)}</span>{comma}</>;
  if (typeof value === "number") return <><span className="jv-number">{String(value)}</span>{comma}</>;
  if (typeof value === "boolean") return <><span className="jv-boolean">{String(value)}</span>{comma}</>;
  return <><span>{JSON.stringify(value)}</span>{comma}</>;
});

function JsonViewer({ object }: { object: unknown }) {
  return (
    <div className="json-viewer">
      <JsonNode value={object} depth={0} isLast />
    </div>
  );
}

// ---- Proto source parsing for message names (lightweight, main thread) ----

function ensureProtoSource(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (/^\s*(syntax|package|import|option|message|enum|service)\b/m.test(trimmed)) return trimmed;
  return `syntax = "proto3";\n${trimmed}`;
}

// Dynamic import of protobufjs only for message-name extraction (no decode/encode here)
let _protobuf: typeof import("protobufjs") | null = null;
async function getProtobuf() {
  if (!_protobuf) _protobuf = await import("protobufjs");
  return _protobuf;
}

async function extractMessageNames(sources: ProtoSource[]): Promise<string[]> {
  const protobuf = await getProtobuf();
  const root = new protobuf.Root();
  for (const src of sources) {
    const content = ensureProtoSource(src.content);
    if (!content) continue;
    protobuf.parse(content, root, {
      keepCase: true, alternateCommentMode: true, filename: src.name,
    } as import("protobufjs").IParseOptions & { filename: string });
  }
  const names: string[] = [];
  function walk(ns: import("protobufjs").NamespaceBase) {
    for (const nested of ns.nestedArray) {
      if (nested instanceof protobuf.Type) names.push(nested.fullName.replace(/^\./, ""));
      if (nested instanceof protobuf.Namespace) walk(nested);
    }
  }
  walk(root);
  return names.sort((a, b) => a.localeCompare(b));
}

// ---- App ----

function App() {
  const [mode, setMode] = useState<OperationMode>("decode");
  const [protoSources, setProtoSources] = useState<ProtoSource[]>([]);
  const [protoText, setProtoText] = useState("");
  const [messageName, setMessageName] = useState("");
  const [messageNames, setMessageNames] = useState<string[]>([]);

  const [decodeInputFormat, setDecodeInputFormat] = useState<DecodeInputFormat>("file");
  const [decodeOutputFormat, setDecodeOutputFormat] = useState<DecodeOutputFormat>("pretty-json");
  const [decodeCompressionMode, setDecodeCompressionMode] = useState<DecodeCompressionMode>("auto");
  const [bytesFileName, setBytesFileName] = useState("");
  const [binaryBytes, setBinaryBytes] = useState<Uint8Array | null>(null);
  const [encodedTextInput, setEncodedTextInput] = useState("");

  const [jsonInputFormat, setJsonInputFormat] = useState<JsonInputFormat>("text");
  const [encodeCompressionMode, setEncodeCompressionMode] = useState<EncodeCompressionMode>("raw");
  const [jsonFileName, setJsonFileName] = useState("");
  const [jsonText, setJsonText] = useState("");

  const [resultState, setResultState] = useState<ResultState>({
    status: "idle", message: "等待输入 proto、message 和数据。", text: "",
  });
  const [decodeDownloadInfo, setDecodeDownloadInfo] = useState({
    fileName: "decoded-protobuf.json", mimeType: "application/json;charset=utf-8",
  });

  const allProtoSources = useMemo(() => {
    const sources = [...protoSources];
    const pasted = ensureProtoSource(protoText);
    if (pasted) sources.push({ name: DEFAULT_PROTO_NAME, content: pasted });
    return sources;
  }, [protoSources, protoText]);

  // Recompute message names asynchronously when sources change
  useEffect(() => {
    if (allProtoSources.length === 0) { setMessageNames([]); return; }
    let cancelled = false;
    extractMessageNames(allProtoSources)
      .then((names) => { if (!cancelled) setMessageNames(names); })
      .catch(() => { if (!cancelled) setMessageNames([]); });
    return () => { cancelled = true; };
  }, [allProtoSources]);

  useEffect(() => {
    if (messageNames.length === 0) { setMessageName(""); return; }
    setMessageName((cur) => (messageNames.includes(cur) ? cur : messageNames[0]));
  }, [messageNames]);

  async function onProtoFilesChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;
    const nextSources = await Promise.all(files.map(async (f) => ({
      name: normalizeProtoName(f.name), content: await readFileAsText(f),
    })));
    setProtoSources(nextSources);
  }

  async function onBytesFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBytesFileName(file.name);
    setBinaryBytes(await readFileAsBytes(file));
    setResultState({ status: "idle", message: `已加载 ${file.name}，等待解码。`, text: "" });
  }

  async function onJsonFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setJsonFileName(file.name); setJsonText(await readFileAsText(file));
    setResultState({ status: "idle", message: `已加载 ${file.name}，等待编码。`, text: "" });
  }

  function validateInputs() {
    if (allProtoSources.length === 0) throw new Error("请上传 .proto 文件，或粘贴 message/proto 内容。");
    if (!messageName.trim()) throw new Error("请先从下拉列表选择 message。");
  }

  function getDecodeBytes(): Uint8Array {
    if (decodeInputFormat === "file") {
      if (!binaryBytes) throw new Error("请先选择 protobuf 二进制文件。");
      return binaryBytes;
    }
    if (decodeInputFormat === "base64") return base64ToBytes(encodedTextInput);
    return hexToBytes(encodedTextInput);
  }

  async function decode() {
    try {
      validateInputs();
      const bytes = getDecodeBytes();
      setResultState({ status: "loading", message: "解码中…", text: "" });

      type WorkerResp = { ok: true; text: string; label: string; fileName: string; mimeType: string } | { ok: false; error: string };
      const resp = await callWorker<WorkerResp>({
        type: "decode",
        sources: allProtoSources,
        messageName: messageName.trim(),
        bytes,
        compressionMode: decodeCompressionMode,
        outputFormat: decodeOutputFormat,
      }, [bytes.buffer.byteLength > 0 ? bytes.buffer : undefined].filter(Boolean) as Transferable[]);

      if (!resp.ok) {
        setResultState({ status: "error", message: resp.error, text: "" });
        return;
      }

      setDecodeDownloadInfo({ fileName: resp.fileName, mimeType: resp.mimeType });

      if (decodeOutputFormat === "pretty-json") {
        // Parse once here so JsonViewer gets the object directly
        let obj: unknown;
        try { obj = JSON.parse(resp.text); } catch { obj = resp.text; }
        setResultState({ status: "ok", message: `解码成功：${resp.label}`, text: resp.text, object: obj });
      } else {
        setResultState({ status: "ok", message: `解码成功：${resp.label}`, text: resp.text });
      }
    } catch (err) {
      setResultState({ status: "error", message: err instanceof Error ? err.message : String(err), text: "" });
    }
  }

  async function encode() {
    try {
      validateInputs();
      const sourceText = jsonText.trim();
      if (!sourceText) throw new Error("请先输入 JSON，或上传 JSON 文件。");
      setResultState({ status: "loading", message: "编码中…", text: "" });

      type WorkerResp = { ok: true; text: string; label: string; fileName: string; mimeType: string; bytes?: Uint8Array } | { ok: false; error: string };
      const resp = await callWorker<WorkerResp>({
        type: "encode",
        sources: allProtoSources,
        messageName: messageName.trim(),
        jsonText: sourceText,
        compressionMode: encodeCompressionMode,
      });

      if (!resp.ok) {
        setResultState({ status: "error", message: resp.error, text: "" });
        return;
      }
      setResultState({ status: "ok", message: `编码成功：${resp.label}`, text: resp.text, bytes: resp.bytes });
    } catch (err) {
      setResultState({ status: "error", message: err instanceof Error ? err.message : String(err), text: "" });
    }
  }

  async function copyResult() {
    const text = resultState.text;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setResultState((cur) => ({ ...cur, message: `${cur.message} 结果已复制。` }));
  }

  const showJsonViewer = mode === "decode" && decodeOutputFormat === "pretty-json"
    && resultState.status === "ok" && resultState.object != null;
  const hasResult = showJsonViewer || !!resultState.text;
  const isLoading = resultState.status === "loading";

  return (
    <main className="app">
      <section className="hero">
        <div>
          <h1>Proto Tools</h1>
          <p>本地编码/解码 protobuf 数据，支持 gzip/raw bytes、JSON、Base64 和 Hex。</p>
        </div>
        <div className="hero-status">
          <span>{mode === "decode" ? "Decode" : "Encode"}</span>
          <span>{allProtoSources.length} proto source</span>
        </div>
      </section>

      <section className="workspace">
        <div className="panel controls">
          <div className="mode-tabs">
            <button className={mode === "decode" ? "active" : ""} onClick={() => setMode("decode")}>Decode</button>
            <button className={mode === "encode" ? "active" : ""} onClick={() => setMode("encode")}>Encode</button>
          </div>

          <FileInput label=".proto 文件，可多选" accept=".proto" multiple
            fileName={protoSources.length > 0 ? protoSources.map((s) => s.name).join("，") : undefined}
            onChange={onProtoFilesChange} />

          <label className="field">
            <span>粘贴 proto 或 message</span>
            <textarea value={protoText} onChange={(e) => setProtoText(e.target.value)} spellCheck={false}
              placeholder={"message ExampleMessage {\n  int32 id = 1;\n}"} />
          </label>

          <label className="field">
            <span>Message</span>
            <select disabled={messageNames.length === 0} value={messageName} onChange={(e) => setMessageName(e.target.value)}>
              <option value="">选择 message</option>
              {messageNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>

          {mode === "decode" ? (
            <>
              <label className="field">
                <span>输入格式</span>
                <select value={decodeInputFormat} onChange={(e) => setDecodeInputFormat(e.target.value as DecodeInputFormat)}>
                  <option value="file">Bytes file</option>
                  <option value="base64">Base64 text</option>
                  <option value="hex">Hex text</option>
                </select>
              </label>

              {decodeInputFormat === "file" ? (
                <FileInput label="二进制文件" fileName={bytesFileName || undefined} onChange={onBytesFileChange} />
              ) : (
                <label className="field">
                  <span>{decodeInputFormat === "base64" ? "Base64" : "Hex"} 输入</span>
                  <textarea value={encodedTextInput} onChange={(e) => setEncodedTextInput(e.target.value)} spellCheck={false}
                    placeholder={decodeInputFormat === "base64" ? "粘贴 Base64 字符串" : "粘贴 Hex 字符串"} />
                </label>
              )}

              <label className="field">
                <span>Bytes 压缩方式</span>
                <select value={decodeCompressionMode} onChange={(e) => setDecodeCompressionMode(e.target.value as DecodeCompressionMode)}>
                  <option value="auto">Auto</option>
                  <option value="gzip">Gzip</option>
                  <option value="raw">Raw / None</option>
                </select>
              </label>

              <label className="field">
                <span>解码输出格式</span>
                <select value={decodeOutputFormat} onChange={(e) => setDecodeOutputFormat(e.target.value as DecodeOutputFormat)}>
                  <option value="pretty-json">Pretty JSON</option>
                  <option value="compact-json">Compact JSON</option>
                  <option value="proto-text">Protobuf Text</option>
                  <option value="field-table">Field Table</option>
                </select>
              </label>

              <button className="primary" onClick={decode} disabled={isLoading}>
                {isLoading ? "解码中…" : "解码"}
              </button>
            </>
          ) : (
            <>
              <label className="field">
                <span>输入格式</span>
                <select value={jsonInputFormat} onChange={(e) => setJsonInputFormat(e.target.value as JsonInputFormat)}>
                  <option value="text">JSON text</option>
                  <option value="file">JSON file</option>
                </select>
              </label>

              {jsonInputFormat === "file" && (
                <FileInput label="JSON 文件" accept=".json,application/json"
                  fileName={jsonFileName || undefined} onChange={onJsonFileChange} />
              )}

              <label className="field">
                <span>JSON 输入</span>
                <textarea value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false}
                  placeholder={'{\n  "id": 1\n}'} />
              </label>

              <label className="field">
                <span>输出压缩方式</span>
                <select value={encodeCompressionMode} onChange={(e) => setEncodeCompressionMode(e.target.value as EncodeCompressionMode)}>
                  <option value="raw">Raw / None</option>
                  <option value="gzip">Gzip</option>
                </select>
              </label>

              <button className="primary" onClick={encode} disabled={isLoading}>
                {isLoading ? "编码中…" : "编码为 Bytes"}
              </button>
            </>
          )}

          <div className="source-list">
            <h2>Proto sources</h2>
            {allProtoSources.length === 0 ? (
              <p>尚未加载 proto。</p>
            ) : (
              <ul>{allProtoSources.map((src, i) => <li key={`${src.name}-${i}`}>{src.name}</li>)}</ul>
            )}
          </div>
        </div>

        <div className="panel output">
          <div className="output-toolbar">
            <div className={`state ${resultState.status === "loading" ? "idle" : resultState.status}`}>
              {resultState.message}
            </div>
            <div className="actions">
              <button onClick={copyResult} disabled={!hasResult}>复制</button>
              {mode === "decode" ? (
                <button onClick={() => downloadText(resultState.text, decodeDownloadInfo.fileName, decodeDownloadInfo.mimeType)}
                  disabled={!hasResult}>下载结果</button>
              ) : (
                <button onClick={() => downloadBytes(resultState.bytes, "encoded-protobuf.bytes")}
                  disabled={!resultState.bytes}>下载 Bytes</button>
              )}
            </div>
          </div>
          {showJsonViewer ? (
            <JsonViewer object={resultState.object} />
          ) : (
            <pre>
              {resultState.text || (mode === "decode" ? "解码结果会显示在这里。" : "编码后的 Base64 和 Hex 会显示在这里。")}
            </pre>
          )}
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
