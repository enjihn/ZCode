import {
  createPdfJsPdfDocumentAdapter,
  createPopplerPdfDocumentAdapter,
} from "@zcode/adapters/pdf";
import type { ExecutionPort, PdfDocumentPort } from "@zcode/contracts";

export function resolvePdfDocumentPort(options: {
  executionPort: ExecutionPort;
  explicitPort?: PdfDocumentPort;
}): PdfDocumentPort {
  // 根因：CLI 启动时会清理 ELECTRON_RUN_AS_NODE；依赖该环境变量会让打包 Agent
  // 误选缺失的 Poppler。Electron 运行时版本在清理后仍可用于识别桌面 Agent。
  return (
    options.explicitPort ??
    (process.versions.electron
      ? createPdfJsPdfDocumentAdapter()
      : createPopplerPdfDocumentAdapter({ executionPort: options.executionPort }))
  );
}
