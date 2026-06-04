# Proto Local Decode Encode Viewer

本地网页工具，用于 protobuf 数据编码和解码。

## 功能

- Decode：把 protobuf bytes 解码为 JSON。
- Encode：把 JSON 编码为 protobuf bytes。
- Decode 输入支持 bytes 文件、Base64 文本、Hex 文本。
- Decode 输出支持 Pretty JSON、Compact JSON、Protobuf Text、Field Table。
- Encode 输入支持 JSON 文本、JSON 文件。
- bytes 压缩方式支持 Auto、Gzip、Raw / None。
- 上传一个或多个 `.proto` 文件，或直接粘贴 `message` / 完整 proto。
- 从已识别 message 下拉列表中选择目标 message，输出 pretty JSON。
- Decode 结果支持复制和下载 JSON。
- Encode 结果支持复制 Base64/Hex 预览和下载 bytes。

## 运行

```bash
npm install
npm run dev
```

打开终端输出的本地地址。

## 使用建议

- 如果 proto 有 import，把相关 `.proto` 文件一起上传。
- Auto 会根据 gzip 文件头自动判断是否解压；如果判断不符合实际，可以手动切换为 Gzip 或 Raw / None。
- message 下拉列表显示完整 message 名称，包含 package 前缀。
- Encode 使用的 JSON 字段名应和 proto 字段名一致。
