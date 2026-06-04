// All heavy protobuf work runs here, off the main thread.
import protobuf from "protobufjs";
import pako from "pako";

type ProtoSource = { name: string; content: string };
type DecodeCompressionMode = "auto" | "gzip" | "raw";
type DecodeOutputFormat = "pretty-json" | "compact-json" | "proto-text" | "field-table";
type EncodeCompressionMode = "raw" | "gzip";

type DecodeRequest = {
  id: number;
  type: "decode";
  sources: ProtoSource[];
  messageName: string;
  bytes: Uint8Array;
  compressionMode: DecodeCompressionMode;
  outputFormat: DecodeOutputFormat;
};

type EncodeRequest = {
  id: number;
  type: "encode";
  sources: ProtoSource[];
  messageName: string;
  jsonText: string;
  compressionMode: EncodeCompressionMode;
};

type WorkerRequest = DecodeRequest | EncodeRequest;

type WorkerResponse =
  | { id: number; ok: true; text: string; label: string; fileName: string; mimeType: string; bytes?: Uint8Array }
  | { id: number; ok: false; error: string };

function looksLikeGzip(bytes: Uint8Array) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function ensureProtoSource(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (/^\s*(syntax|package|import|option|message|enum|service)\b/m.test(trimmed)) return trimmed;
  return `syntax = "proto3";\n${trimmed}`;
}

function buildRoot(sources: ProtoSource[]) {
  const root = new protobuf.Root();
  const parsedFiles = new Set<string>();
  for (const src of sources) {
    const content = ensureProtoSource(src.content);
    if (!content) continue;
    protobuf.parse(content, root, {
      keepCase: true,
      alternateCommentMode: true,
      filename: src.name,
    } as protobuf.IParseOptions & { filename: string });
    parsedFiles.add(src.name);
  }
  root.resolveAll();
  return { root, parsedFiles };
}

function formatScalar(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null) return "null";
  return JSON.stringify(v);
}

function formatProtoText(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) return value.map((item) => formatProtoText(item, indent)).join("\n");
  if (!value || typeof value !== "object") return `${pad}${formatScalar(value)}`;
  const lines: string[] = [];
  for (const [key, fv] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(fv)) {
      for (const item of fv) {
        if (item && typeof item === "object") {
          lines.push(`${pad}${key} {`); lines.push(formatProtoText(item, indent + 1)); lines.push(`${pad}}`);
        } else { lines.push(`${pad}${key}: ${formatScalar(item)}`); }
      }
      continue;
    }
    if (fv && typeof fv === "object") {
      lines.push(`${pad}${key} {`); lines.push(formatProtoText(fv, indent + 1)); lines.push(`${pad}}`);
    } else { lines.push(`${pad}${key}: ${formatScalar(fv)}`); }
  }
  return lines.join("\n");
}

function collectFieldRows(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${path}\t[]`];
    return value.flatMap((item, i) => collectFieldRows(item, `${path}[${i}]`));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [`${path}\t{}`];
    return entries.flatMap(([key, v]) => collectFieldRows(v, `${path}.${key}`));
  }
  return [`${path}\t${formatScalar(value)}`];
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === "decode") {
      const { root, parsedFiles } = buildRoot(req.sources);
      const type = root.lookupType(req.messageName);

      // Decompress
      let bytes = req.bytes;
      let comprLabel: string;
      if (req.compressionMode === "raw") { comprLabel = "raw bytes"; }
      else if (req.compressionMode === "gzip") { bytes = pako.ungzip(bytes); comprLabel = "gzip"; }
      else if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) { bytes = pako.ungzip(bytes); comprLabel = "auto gzip"; }
      else { comprLabel = "auto raw bytes"; }

      const message = type.decode(bytes);
      const object = type.toObject(message, {
        longs: String, enums: String, bytes: String,
        defaults: false, arrays: true, objects: true,
      });

      let text: string;
      let fileName: string;
      let mimeType: string;
      let fmtLabel: string;

      switch (req.outputFormat) {
        case "pretty-json":
          text = JSON.stringify(object, null, 2);
          fileName = "decoded-protobuf.json"; mimeType = "application/json;charset=utf-8"; fmtLabel = "Pretty JSON";
          break;
        case "compact-json":
          text = JSON.stringify(object);
          fileName = "decoded-protobuf.json"; mimeType = "application/json;charset=utf-8"; fmtLabel = "Compact JSON";
          break;
        case "proto-text":
          text = formatProtoText(object);
          fileName = "decoded-protobuf.textproto"; mimeType = "text/plain;charset=utf-8"; fmtLabel = "Protobuf Text";
          break;
        case "field-table":
          text = ["Path\tValue", ...collectFieldRows(object)].join("\n");
          fileName = "decoded-protobuf.tsv"; mimeType = "text/tab-separated-values;charset=utf-8"; fmtLabel = "Field Table";
          break;
        default:
          text = ""; fileName = ""; mimeType = ""; fmtLabel = "";
      }

      const label = `${comprLabel} -> ${fmtLabel}，已加载 ${parsedFiles.size} 个 proto 文件。`;
      const resp: WorkerResponse = { id: req.id, ok: true, text, label, fileName, mimeType };
      self.postMessage(resp);
    } else {
      // encode
      const { root, parsedFiles } = buildRoot(req.sources);
      const type = root.lookupType(req.messageName);
      const object = JSON.parse(req.jsonText);
      const verifyError = type.verify(object);
      if (verifyError) throw new Error(`JSON 与 message 不匹配：${verifyError}`);
      const message = type.fromObject(object);
      const rawBytes = type.encode(message).finish();
      let outBytes: Uint8Array;
      let comprLabel: string;
      if (req.compressionMode === "gzip") { outBytes = pako.gzip(rawBytes); comprLabel = "gzip"; }
      else { outBytes = rawBytes; comprLabel = "raw bytes"; }
      const base64 = bytesToBase64(outBytes);
      const hex = bytesToHex(outBytes);
      const text = `Base64:\n${base64}\n\nHex:\n${hex}`;
      const label = `${comprLabel}，输出 ${outBytes.length} bytes，已加载 ${parsedFiles.size} 个 proto 文件。`;
      const resp: WorkerResponse = {
        id: req.id, ok: true, text, label,
        fileName: "encoded-protobuf.bytes", mimeType: "application/octet-stream",
        bytes: outBytes,
      };
      // Transfer the buffer to avoid copying large byte arrays
      self.postMessage(resp, [outBytes.buffer]);
    }
  } catch (err) {
    const resp: WorkerResponse = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(resp);
  }
};
