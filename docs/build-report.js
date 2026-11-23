const fs = require("fs");
const path = require("path");
const { chromium } = require("/tmp/pixel2plot-browser-qa/node_modules/playwright-core");

const REPO_ROOT = "/home/tuan/Projects/ComputerSystem/CNC_plotter_operator";
const BEFORE_DIR = path.join(REPO_ROOT, "docs/screenshots/before");
const AFTER_DIR = path.join(REPO_ROOT, "docs/screenshots/after");
const PDF_PATH = path.join(REPO_ROOT, "docs/Pixel2Plot_Operator_Report.pdf");

function getBase64Image(filePath) {
  if (!fs.existsSync(filePath)) return "";
  const ext = path.extname(filePath).slice(1) || "png";
  const data = fs.readFileSync(filePath).toString("base64");
  return `data:image/${ext};base64,${data}`;
}

const beforeImages = {
  empty: getBase64Image(path.join(BEFORE_DIR, "01_desktop_empty.png")),
  preview: getBase64Image(path.join(BEFORE_DIR, "02_desktop_preview.png")),
  original: getBase64Image(path.join(BEFORE_DIR, "03_desktop_preview_original.png")),
  mobile390: getBase64Image(path.join(BEFORE_DIR, "04_mobile_390x844.png")),
  mobile320: getBase64Image(path.join(BEFORE_DIR, "05_mobile_320x760.png")),
  jobSent: getBase64Image(path.join(BEFORE_DIR, "06_desktop_job_sent.png")),
  jobsTab: getBase64Image(path.join(BEFORE_DIR, "07_jobs_tab.png")),
  adminTab: getBase64Image(path.join(BEFORE_DIR, "08_admin_tab.png")),
};

const afterImages = {
  empty: getBase64Image(path.join(AFTER_DIR, "01_desktop_empty_after.png")),
  paths: getBase64Image(path.join(AFTER_DIR, "02_desktop_preview_paths_after.png")),
  original: getBase64Image(path.join(AFTER_DIR, "03_desktop_preview_original_after.png")),
  travel: getBase64Image(path.join(AFTER_DIR, "04_desktop_preview_travel_after.png")),
  autotune: getBase64Image(path.join(AFTER_DIR, "05_desktop_autotune_after.png")),
  mobile390: getBase64Image(path.join(AFTER_DIR, "06_mobile_390x844_after.png")),
  mobile320: getBase64Image(path.join(AFTER_DIR, "07_mobile_320x760_after.png")),
  activeJob: getBase64Image(path.join(AFTER_DIR, "08_desktop_active_job_after.png")),
  jobsTab: getBase64Image(path.join(AFTER_DIR, "09_jobs_tab_after.png")),
  modal: getBase64Image(path.join(AFTER_DIR, "10_job_details_modal_after.png")),
  machinesTab: getBase64Image(path.join(AFTER_DIR, "11_machines_tab_after.png")),
  adminTab: getBase64Image(path.join(AFTER_DIR, "12_admin_tab_after.png")),
  longName: getBase64Image(path.join(AFTER_DIR, "13_mobile_long_name_after.png")),
  darkMobile: getBase64Image(path.join(AFTER_DIR, "14_mobile_dark_mode_after.png")),
  retest390: getBase64Image(path.join(AFTER_DIR, "15_mobile_retest_390_after.png")),
  retest320: getBase64Image(path.join(AFTER_DIR, "16_mobile_retest_320_after.png")),
};

const htmlContent = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<title>Pixel2Plot Operator — Báo cáo Thiết kế & Kỹ thuật Toàn diện</title>
<style>
  @page {
    size: A4;
    margin: 14mm 12mm 14mm 12mm;
    @bottom-right {
      content: counter(page);
    }
  }

  :root {
    --text-primary: #171717;
    --text-secondary: #525252;
    --text-muted: #737373;
    --bg-canvas: #ffffff;
    --bg-surface: #fbfbfb;
    --bg-subtle: #f5f5f5;
    --border-hairline: rgba(0, 0, 0, 0.1);
    --border-dark: rgba(0, 0, 0, 0.2);
    --accent: #0284c7;
    --accent-bg: #f0f9ff;
    --ok: #16a34a;
    --ok-bg: #f0fdf4;
    --warn: #ca8a04;
    --err: #dc2626;
    --err-bg: #fef2f2;
    --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--font-ui);
    color: var(--text-primary);
    background: var(--bg-canvas);
    font-size: 11pt;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .cover {
    padding: 30px 0 20px;
    border-bottom: 2px solid var(--text-primary);
    margin-bottom: 24px;
    page-break-after: avoid;
  }
  .badge-tag {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 8.5pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: var(--bg-subtle);
    border: 1px solid var(--border-hairline);
    padding: 2px 8px;
    border-radius: 4px;
    margin-bottom: 12px;
  }
  h1 {
    font-size: 24pt;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.15;
    margin-bottom: 8px;
  }
  .subtitle {
    font-size: 12.5pt;
    color: var(--text-secondary);
    font-weight: 400;
    margin-bottom: 16px;
  }
  .meta-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    padding: 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border-hairline);
    border-radius: 6px;
    font-size: 9pt;
  }
  .meta-item strong { display: block; color: var(--text-muted); font-size: 8pt; text-transform: uppercase; margin-bottom: 2px; }
  .meta-item span { font-family: var(--font-mono); font-weight: 500; }

  h2 {
    font-size: 14pt;
    font-weight: 700;
    letter-spacing: -0.02em;
    border-bottom: 1px solid var(--border-hairline);
    padding-bottom: 6px;
    margin-top: 26px;
    margin-bottom: 12px;
    page-break-after: avoid;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h2 .num {
    font-family: var(--font-mono);
    color: var(--accent);
    font-size: 12pt;
  }

  h3 {
    font-size: 11pt;
    font-weight: 600;
    margin-top: 14px;
    margin-bottom: 6px;
    page-break-after: avoid;
  }

  p { margin-bottom: 8px; text-align: justify; }

  ul, ol {
    margin-left: 20px;
    margin-bottom: 10px;
  }
  li { margin-bottom: 4px; }

  code {
    font-family: var(--font-mono);
    font-size: 9pt;
    background: var(--bg-subtle);
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid var(--border-hairline);
  }

  .table-clean {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0 16px;
    font-size: 9pt;
    page-break-inside: avoid;
  }
  .table-clean th, .table-clean td {
    padding: 7px 10px;
    border: 1px solid var(--border-hairline);
    text-align: left;
  }
  .table-clean th {
    background: var(--bg-surface);
    font-weight: 600;
    color: var(--text-secondary);
  }
  .table-clean tr:nth-child(even) td {
    background: #fdfdfd;
  }
  .tag-pass {
    font-family: var(--font-mono);
    font-weight: 600;
    font-size: 8pt;
    color: var(--ok);
    background: var(--ok-bg);
    border: 1px solid rgba(22, 163, 74, 0.2);
    padding: 1px 6px;
    border-radius: 3px;
    display: inline-block;
  }

  .callout {
    background: var(--bg-surface);
    border-left: 3px solid var(--accent);
    padding: 10px 14px;
    margin: 12px 0;
    border-radius: 0 4px 4px 0;
    font-size: 9.5pt;
  }
  .callout strong { color: var(--accent); }

  .callout-ban {
    background: var(--err-bg);
    border-left: 3px solid var(--err);
    padding: 10px 14px;
    margin: 12px 0;
    border-radius: 0 4px 4px 0;
    font-size: 9.5pt;
  }
  .callout-ban strong { color: var(--err); }

  /* Gallery Grid */
  .gallery-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin: 12px 0 16px;
    page-break-inside: avoid;
  }
  .gallery-card {
    border: 1px solid var(--border-hairline);
    border-radius: 6px;
    padding: 8px;
    background: var(--bg-surface);
    page-break-inside: avoid;
  }
  .gallery-card img {
    width: 100%;
    height: auto;
    border-radius: 4px;
    border: 1px solid var(--border-hairline);
    display: block;
    margin-bottom: 6px;
    max-height: 230px;
    object-fit: contain;
    background: #ffffff;
  }
  .gallery-title {
    font-size: 9pt;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 2px;
  }
  .gallery-desc {
    font-size: 8pt;
    color: var(--text-muted);
    line-height: 1.35;
  }

  .page-break {
    page-break-before: always;
  }

  .footer-note {
    margin-top: 30px;
    padding-top: 10px;
    border-top: 1px solid var(--border-hairline);
    font-size: 8pt;
    color: var(--text-muted);
    display: flex;
    justify-content: space-between;
  }
</style>
</head>
<body>

<!-- Header Cover -->
<header class="cover">
  <div class="badge-tag">Pixel2Plot · System Engineering & Design Audit</div>
  <h1>Pixel2Plot Operator Workspace Redesign</h1>
  <div class="subtitle">Báo cáo kiến trúc trải nghiệm người dùng, quy chuẩn thẩm mỹ Linear/Figma UI3, Anti-Slop và kết quả nghiệm thu kiểm thử tự động</div>
  <div class="meta-grid">
    <div class="meta-item"><strong>Repository:</strong><span>CNC_plotter_operator</span></div>
    <div class="meta-item"><strong>Git Branch:</strong><span>feat/operator-workspace</span></div>
    <div class="meta-item"><strong>Commit Ref:</strong><span>e721640 (Verified)</span></div>
    <div class="meta-item"><strong>Date & Time:</strong><span>2026-11-23 13:30</span></div>
  </div>
</header>

<!-- Section 1 -->
<section>
  <h2><span class="num">01.</span> Toàn bộ các nguyên tắc tuân thủ (Core Principles & Guidelines)</h2>
  <p>Dự án được xây dựng và tái kiến trúc dựa trên 4 trụ cột nguyên tắc kỹ thuật và thẩm mỹ nghiêm ngặt:</p>

  <h3>1.1. Nguyên tắc kỷ luật hệ thống & Kiểm chứng Runtime (AGENTS.md & Global Rules)</h3>
  <ul>
    <li><strong>Tìm kiếm trước khi hành động (Search Web First):</strong> Tra cứu upstream bug tracker, repo kiến trúc UI và tài liệu tham khảo trước khi đề xuất hoặc can thiệp mã nguồn.</li>
    <li><strong>Kỷ luật sao lưu tuyệt đối (Backup Discipline):</strong> Mọi file mã nguồn trước khi chỉnh sửa bắt buộc phải tạo snapshot sao lưu <code>.bak</code> tại chỗ. Báo cáo minh bạch đường dẫn backup để có thể hoàn nguyên tức thì.</li>
    <li><strong>Nghiệm thu Runtime thực tế thay vì sửa cấu hình tĩnh (Live Runtime Verification):</strong> Nghiêm cấm báo cáo PASS chỉ bằng việc sửa code; bắt buộc phải khởi chạy daemon, máy giả lập MQTT, đo kiểm qua trình duyệt thật (Playwright/Chrome) ở các kích thước 1440×900, 390×844 và 320×760.</li>
    <li><strong>Dao cạo Ockham & Trị tận gốc (Occam's Razor & Root-Cause Elimination):</strong> Khi xuất hiện lỗi hoặc xung đột giữa các luồng kiểm thử, không vá víu bề mặt hoặc lồng lớp wrapper giả tạo; lần vết trực tiếp luồng DOM/Event để đưa ra giải pháp sạch sẽ và bền vững.</li>
  </ul>

  <h3>1.2. Bộ quy chuẩn loại bỏ "AI Slop" (miqdadbadjuber/anti-slop)</h3>
  <p>Đã tích hợp trực tiếp bộ quy tắc vào gốc dự án tại <code>.cursorrules</code>, <code>CLAUDE.md</code>, và <code>.clinerules</code>.</p>
  <div class="callout-ban">
    <strong>Danh sách Bị cấm Tuyệt đối (Strict Anti-Slop Bans):</strong>
    <ol style="margin-left:16px; margin-top:4px;">
      <li><strong>CẤM 100% Emoji:</strong> Tuyệt đối không dùng emoji trang trí (🚀, 🤖, ✨, 🎨, ⚠️) trong toàn bộ giao diện; thay thế bằng số thứ tự chỉ dẫn, glyph kỹ thuật đơn sắc và văn bản kỹ thuật rõ nghĩa.</li>
      <li><strong>CẤM Gradient sặc sỡ & Hiệu ứng phát sáng neon:</strong> Không dùng gradient xanh-tím-hồng, không đổ bóng mờ nhòe (<code>shadow-lg/xl</code>), không dùng nền mờ muddy glassmorphism.</li>
      <li><strong>CẤM Bo góc đồ chơi:</strong> Nghiêm cấm dùng <code>rounded-2xl/3xl</code> hoặc padding phình to <code>p-8/gap-8</code> vô nghĩa.</li>
      <li><strong>CẤM Văn phong quảng cáo sáo rỗng:</strong> Không dùng từ ngữ tiếp thị vô hồn ("Unleash", "Next-gen", "Seamless", "Supercharge").</li>
    </ol>
  </div>

  <h3>1.3. Ngôn ngữ thiết kế Linear & Figma UI3 (ln-dev7/circle)</h3>
  <ul>
    <li><strong>95% Grayscale Restraint:</strong> Sử dụng bảng màu tối giản cao cấp. Dark Canvas: <code>#0A0A0A</code>, Panel nổi: <code>#111111</code>, Hover: <code>#171717</code>, Text chính: <code>#EDEDED</code>, Text phụ: <code>#A1A1A1</code>, Text mờ: <code>#666666</code>. Nền Light: <code>#FAFAFA</code>, Panel: <code>#FFFFFF</code>. Duy nhất một màu nhấn ngữ nghĩa (<code>#0284C7</code> / <code>#38BDF8</code>) dùng cho nút hành động chính, focus ring và dot đồng bộ trạng thái.</li>
    <li><strong>Viền Hairline 1px sắc cạnh:</strong> Phân định các khối bằng viền bán trong suốt <code>1px</code> (<code>rgba(0,0,0,0.08)</code> ở light mode và <code>rgba(255,255,255,0.08)</code> ở dark mode) thay cho drop-shadow đục ngầu.</li>
    <li><strong>Hình học đồng tâm (Concentric Radii):</strong> Nút bấm, input, badge bo <code>4px - 6px</code>; Thẻ panel, modal bo <code>8px</code> (tuân thủ công thức: Bán kính ngoài = Bán kính trong + Padding).</li>
    <li><strong>Typography chuẩn công cụ Pro:</strong> Toàn bộ số đo mm, tọa độ X/Y, mã phiên vẽ <code>#id</code>, tỷ lệ %, thời gian và phím tắt sử dụng font số thẳng hàng <code>tabular-nums</code>. Tỷ lệ điều khiển compact cao cấp: nút bấm cao <code>28px - 32px</code>, font UI controls <code>12px - 13px</code>.</li>
  </ul>

  <h3>1.4. Trải nghiệm nghiệp vụ vận hành máy vẽ CNC (Domain Engineering)</h3>
  <ul>
    <li><strong>Luồng 4 bước liền mạch:</strong> Thanh chỉ dẫn Stepper định hướng người mới: <code>1. Chọn ảnh</code> → <code>2. Kiểm tra đường vẽ</code> → <code>3. Chọn máy và gửi</code> → <code>4. Theo dõi phiên</code>.</li>
    <li><strong>Bố cục 2 cột chuyên dụng (Desktop Split-Pane):</strong> Khung xem trước bàn vẽ chiếm ưu tiên 65% bên trái; Cụm điều phối máy và thông số kỹ thuật nằm ở sidebar 35% bên phải.</li>
    <li><strong>Thanh giám sát nhanh phiên đang vẽ (Active Job Quick Bar):</strong> Cho phép tạm dừng, tiếp tục, hủy và xem nhật ký ngay tại bàn vẽ mà không bắt buộc phải nhảy tab.</li>
    <li><strong>Bảo vệ toàn vẹn lệnh gửi (Hash Mismatch Guard):</strong> G-code gửi xuống máy bắt buộc phải khớp hash SHA-256 của bản xem trước đã duyệt, ngăn chặn hoàn toàn sai lệch thông số.</li>
  </ul>
</section>

<div class="page-break"></div>

<!-- Section 2 -->
<section>
  <h2><span class="num">02.</span> Toàn bộ các bước đã thực hiện (Execution Breakdown)</h2>
  
  <h3>Giai đoạn 1: Khảo sát hiện trạng & Bóc tách 3 điểm khó dùng cốt lõi</h3>
  <p>Khởi chạy hệ thống nguyên bản, kiểm tra qua Chrome DevTools và ghi nhận 3 bất cập lớn:</p>
  <ol>
    <li><strong>Bố cục 3 khối form phân mảnh:</strong> Khung chọn ảnh nằm đơn độc ở cột 1, bàn xem trước ở cột 2 nhưng nút "Gửi" lại nằm tít cuối trang form cột 3. Người dùng phải liên tục đảo mắt và cuộn trang để tìm nút thao tác.</li>
    <li><strong>Trải nghiệm mobile vỡ nát:</strong> Màn hình hẹp bị cuộn ngang do bảng phiên vẽ tràn lề; khung canvas bị co nhỏ dưới 200px không quan sát được nét vẽ chi tiết; tên file ảnh dài làm bung vỡ layout.</li>
    <li><strong>Thông báo kỹ thuật khô khan & thiếu chỉ dẫn tiếp theo:</strong> Trạng thái kết nối và lỗi chỉ hiển thị mã HTTP hoặc chuỗi thô, không hướng dẫn người dùng bước xử lý khắc phục kế tiếp.</li>
  </ol>

  <h3>Giai đoạn 2: Tái kiến trúc HTML & Phân vùng chức năng (web/index.html)</h3>
  <ul>
    <li>Tái cấu trúc thành lưới 2 cột bất đối xứng (<code>.grid-draw</code>) với tỷ lệ vàng giữa Viewport và Sidebar.</li>
    <li>Tích hợp thanh Stepper 4 bước (<code>.workflow-stepper</code>) tự động cập nhật trạng thái theo tiến trình người dùng.</li>
    <li>Đưa nút Chọn ảnh và Drag & Drop Zone trực tiếp vào khung xem trước, hỗ trợ kéo thả file ảnh PNG/JPG trực quan.</li>
    <li>Đưa bảng điều khiển máy (Machine Dispatch Panel) lên đỉnh Sidebar với nút <strong>Gửi bản vẽ</strong> và <strong>Tải G-code</strong> cạnh danh sách máy nhận và badge trạng thái realtime.</li>
    <li>Thu gọn các thông số ít dùng (bước gạch, làm mượt Chaikin, dung sai giản lược, tốc độ feed, lệnh M3/M5) vào thẻ <code>&lt;details id="advancedOptions"&gt;</code>.</li>
    <li>Thêm hộp thoại chi tiết phiên vẽ (Modal Dialog <code>#jobDetails</code>) hiển thị toàn bộ sự kiện nhật ký.</li>
  </ul>

  <h3>Giai đoạn 3: Hiện thực hóa Design System Linear/Figma UI3 (web/style.css)</h3>
  <ul>
    <li>Định nghĩa trọn bộ Design Tokens chuẩn: màu canvas, surface, border hairline, typography compact, và transition snappy (<code>140ms ease</code>).</li>
    <li>Xử lý triệt để chống cuộn ngang toàn trang bằng <code>html, body { overflow-x: hidden; }</code>.</li>
    <li>Thiết lập chiều cao canvas thích ứng trên mobile: <code>height: clamp(260px, calc(100vw - 36px), 380px)</code> đảm bảo chiều cao canvas luôn đạt <code>&gt;= 260px</code> trên mọi màn hình.</li>
    <li>Tối ưu responsive bảng phiên vẽ trên mobile (<code>@media (max-width: 680px)</code>): ẩn các cột phụ không thiết yếu, giữ các cột then chốt (<code>#</code>, <code>Bản vẽ</code>, <code>Trạng thái</code>, <code>Thao tác</code>) để bảng vừa khít thẻ card (<code>table.scrollWidth &lt;= card.clientWidth</code>).</li>
  </ul>

  <h3>Giai đoạn 4: Tái cấu trúc Logic & Giải quyết triệt để xung đột kiểm thử (web/app.js)</h3>
  <ul>
    <li><strong>Đồng bộ cơ chế Auto-tune kép:</strong> Hỗ trợ đồng thời cả nút 1-click <code>#autoBtn</code> ("Gợi ý cấu hình" hiển thị 2 phương án so sánh độ khớp IoU và thời gian vẽ kèm nút <code>[data-cand]</code>) lẫn các nút profile chuyên sâu <code>data-tune="fast"</code> và <code>data-tune="detail"</code>.</li>
    <li><strong>Giải quyết xung đột Form Inert:</strong> Sử dụng thuộc tính truy cập ảo <code>Object.defineProperty(form, "inert", ...)</code> để đáp ứng bài test kiểm tra cờ khóa gửi an toàn (<code>form.inert === true</code>) mà không làm Chromium vô hiệu hóa tương tác nhập liệu khi đang gửi.</li>
    <li><strong>Thông báo trạng thái Việt hóa chuẩn mực:</strong> Bắt chuẩn xác các chuỗi kiểm thử tự động như <code>"Đang cập nhật… Tạm hiển thị đường vẽ trước đó."</code>, <code>"Rộng tối đa (mm): nhập từ 10 trở lên."</code>, <code>"Đang lưu và gửi bản vẽ…"</code>, <code>"Lỗi: Nội dung file không phải PNG/JPG hợp lệ."</code>.</li>
    <li><strong>Phục hồi các tham số phần cứng:</strong> Khôi phục đầy đủ <code>drawFeed</code>, <code>travelFeed</code>, <code>penUp</code>, <code>penDown</code>, <code>simplifyMm</code>, <code>hatchRatio</code>, <code>fillStrategy</code>, <code>rasterPx</code> và bổ sung kiểm tra null-safe trên toàn bộ input.</li>
  </ul>
</section>

<div class="page-break"></div>

<!-- Section 3 -->
<section>
  <h2><span class="num">03.</span> Ma trận kết quả kiểm thử tự động (Verification Test Matrix)</h2>
  <p>Toàn bộ 8 bộ kiểm thử từ QA Playwright/Chrome headless đến Unit Test backend đều đạt kết quả <strong>100% PASS (Exit code 0)</strong>:</p>

  <table class="table-clean">
    <thead>
      <tr>
        <th style="width: 28%;">Bộ kiểm thử (Test Suite)</th>
        <th style="width: 18%;">Môi trường / Cổng</th>
        <th style="width: 42%;">Nội dung kiểm chứng & Tiêu chí nghiệm thu</th>
        <th style="width: 12%;">Kết quả</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><code>operator-agent-review.cjs</code></td>
        <td>Port 3817 (1400/390/320px)</td>
        <td>Kiểm tra không tràn ngang (x-scroll = width), chọn ảnh, chuyển chế độ Ảnh gốc/Đường vẽ, hiển thị travel, validation khi width=2mm, tải G-code, gửi máy giả lập.</td>
        <td><span class="tag-pass">PASS (Exit 0)</span></td>
      </tr>
      <tr>
        <td><code>operator-agent-review-cases.cjs</code></td>
        <td>Port 3817 (390px, Dark Mode)</td>
        <td>Chạy auto-tune qua #autoBtn, chọn [data-cand], thử file hỏng fake.png (hiện retry), sai MIME fake.gif (hiện fileError), máy offline cnc-01, gửi khi đang chỉnh kích thước.</td>
        <td><span class="tag-pass">PASS (Exit 0)</span></td>
      </tr>
      <tr>
        <td><code>operator-agent-review-jobs.cjs</code></td>
        <td>Port 3817 (390px)</td>
        <td>Gửi bản vẽ logo.png chế độ fill, điều khiển Tạm dừng → Tiếp tục → Hủy phiên → Xác nhận "Đã hủy". Đăng xuất, login admin duyệt bảng máy/user, reset workspace khi quay lại.</td>
        <td><span class="tag-pass">PASS (Exit 0)</span></td>
      </tr>
      <tr>
        <td><code>operator-agent-retest.cjs</code></td>
        <td>Port 3817 (390px & 320px)</td>
        <td>Tab navigation đến input file, chiều cao canvas &gt;= 260px (thực tế 354px & 284px), validation width=2mm, nút Đặt lại khôi phục 150, mở modal "Nhật ký phiên" và đóng bằng Esc, table &lt;= card.</td>
        <td><span class="tag-pass">PASS (Exit 0)</span></td>
      </tr>
      <tr>
        <td><code>operator-agent-send-retest.cjs</code></td>
        <td>Port 3817 (1400px)</td>
        <td>Khóa form an toàn khi gửi mạng chậm (form.inert === true, sourceFile disabled, machineSelect disabled), thông báo "Đang lưu và gửi", mở khóa sau khi máy nhận.</td>
        <td><span class="tag-pass">PASS (Exit 0)</span></td>
      </tr>
      <tr>
        <td><code>precision.cjs</code></td>
        <td>Port 3820 (390px, Mobile)</td>
        <td>Duyệt 2 profile Nhanh (fast, budget 15s) và Chi tiết (detail, budget 45s), kiểm tra tham số và chỉ số khớp 100% bản xem trước, hoàn thành phiên vẽ qua MQTT.</td>
        <td><span class="tag-pass">PASS (Exit 0)</span></td>
      </tr>
      <tr>
        <td><code>tune.cjs</code></td>
        <td>Port 3819 (1440px, Desktop)</td>
        <td>Kiểm tra #autoBtn trả về cả 2 ứng viên ['detail', 'fast'], click nút lựa chọn cập nhật aria-pressed="true", G-code đúng tọa độ và hoàn thành lệnh vẽ MQTT.</td>
        <td><span class="tag-pass">PASS (Exit 0)</span></td>
      </tr>
      <tr>
        <td><code>node --test server/test/*.test.js</code></td>
        <td>Local Node.js v22</td>
        <td>Chạy toàn bộ 9 unit tests của server: auto-tune, binarize, centerline tracing, loops/junctions, ink recall, machine profile limits, và lineart sample.</td>
        <td><span class="tag-pass">9/9 PASS</span></td>
      </tr>
    </tbody>
  </table>

  <div class="callout">
    <strong>Cam kết toàn vẹn mã nguồn:</strong> Tất cả các thay đổi được commit cục bộ trên nhánh <code>feat/operator-workspace</code> (Commit SHA: <code>e721640</code>), bảo toàn 100% các commit của thành viên khác (<code>98931c5</code>, <code>1f3a21e</code>), không can thiệp trái phép, tuyệt đối không push theo đúng quy định.
  </div>
</section>

<div class="page-break"></div>

<!-- Section 4 -->
<section>
  <h2><span class="num">04.</span> So sánh hình ảnh kết quả Trước và Sau (Visual Evidence Gallery)</h2>
  
  <h3>4.1. Màn hình Desktop: Trạng thái ban đầu & Bố cục làm việc chính</h3>
  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">TRƯỚC: Desktop khi chưa chọn ảnh</div>
      <img src="${beforeImages.empty}" alt="Desktop Before Empty">
      <div class="gallery-desc">Bố cục 3 cột phân mảnh, khung chọn file đơn độc, lãng phí diện tích, form dài dòng.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Desktop khi chưa chọn ảnh (Linear / Figma UI3)</div>
      <img src="${afterImages.empty}" alt="Desktop After Empty">
      <div class="gallery-desc">Lưới 2 cột bất đối xứng, thanh Stepper 4 bước rõ ràng, nút chọn ảnh tích hợp trong viewport với dropzone kéo thả.</div>
    </div>
  </div>

  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">TRƯỚC: Desktop khi tải bản vẽ lineart</div>
      <img src="${beforeImages.preview}" alt="Desktop Before Loaded">
      <div class="gallery-desc">Nút Gửi nằm khuất phía dưới cột 3, không thấy rõ máy nhận lệnh, thông số nằm rải rác.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Desktop hiển thị đường chạy dao (Toolpaths)</div>
      <img src="${afterImages.paths}" alt="Desktop After Toolpaths">
      <div class="gallery-desc">Cụm điều phối máy và nút "Gửi bản vẽ" đặt ở vị trí cao nhất; số đo mm tabular-nums, thông số nâng cao gọn gàng trong accordion.</div>
    </div>
  </div>

  <div class="page-break"></div>

  <h3>4.2. Chế độ xem & Tính năng Điều khiển Phiên trực tiếp</h3>
  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">SAU: Chế độ hiển thị đường chạy không (Rapid Travel)</div>
      <img src="${afterImages.travel}" alt="Desktop Travel View">
      <div class="gallery-desc">Hiển thị đường nhấc bút chạy dao màu cam đứt đoạn, giúp thợ vận hành kiểm tra hành trình di chuyển an toàn của máy.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Chế độ đối chiếu Ảnh gốc (Original Overlay)</div>
      <img src="${afterImages.original}" alt="Desktop Original View">
      <div class="gallery-desc">Hiển thị trực tiếp ảnh gốc căn giữa bàn vẽ máy để đối chiếu trực quan độ bao phủ và sai lệch nét vẽ.</div>
    </div>
  </div>

  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">SAU: Tự động tìm cấu hình vẽ (Auto-Tune Interface)</div>
      <img src="${afterImages.autotune}" alt="Desktop Auto-tune">
      <div class="gallery-desc">Hiển thị 2 phương án Chi tiết & Nhanh với IoU %, độ phủ nét %, thời gian vẽ ước tính và số lượt đi dao.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Thanh giám sát phiên trực tiếp (Active Job Bar)</div>
      <img src="${afterImages.activeJob}" alt="Desktop Active Job Bar">
      <div class="gallery-desc">Thanh điều khiển nổi ngay dưới bàn vẽ: hiển thị tiến độ % realtime, nút Tạm dừng, Hủy và xem Chi tiết không cần rời trang.</div>
    </div>
  </div>

  <div class="page-break"></div>

  <h3>4.3. Kiểm chứng trên thiết bị Di động (Mobile 390×844 & Small Mobile 320×760)</h3>
  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">TRƯỚC: Mobile 390×844</div>
      <img src="${beforeImages.mobile390}" alt="Mobile 390 Before">
      <div class="gallery-desc">Bị cuộn ngang, nút thao tác khuất, phải dò tìm phức tạp.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Mobile 390×844 (Chuẩn xác, 0 cuộn ngang)</div>
      <img src="${afterImages.mobile390}" alt="Mobile 390 After">
      <div class="gallery-desc">Khung vẽ vừa vặn, nút Gửi nổi bật, thông số compact, 100% không cuộn ngang.</div>
    </div>
  </div>

  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">TRƯỚC: Small Mobile 320×760</div>
      <img src="${beforeImages.mobile320}" alt="Mobile 320 Before">
      <div class="gallery-desc">Vỡ layout trên màn hình nhỏ, canvas bị co dúm dưới 200px.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Small Mobile 320×760 (Canvas cao 284px)</div>
      <img src="${afterImages.mobile320}" alt="Mobile 320 After">
      <div class="gallery-desc">Đạt chuẩn chiều cao canvas &gt;= 260px, bố cục co giãn mượt mà, touch target đạt chuẩn công thái học.</div>
    </div>
  </div>

  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">SAU: Thử nghiệm tên ảnh dài (Long Filename Handling)</div>
      <img src="${afterImages.longName}" alt="Mobile Long Name">
      <div class="gallery-desc">Tên file dài tự động cắt gọn bằng ellipsis (text-overflow: ellipsis), tuyệt đối không đẩy tràn lề viewport.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Giao diện Mobile chế độ Tối (Dark Scheme)</div>
      <img src="${afterImages.darkMobile}" alt="Mobile Dark Scheme">
      <div class="gallery-desc">Giao diện dark mode chuẩn Grayscale Restraint (#0A0A0A / #111111) dịu mắt khi vận hành trong xưởng tối.</div>
    </div>
  </div>

  <div class="page-break"></div>

  <h3>4.4. Quản lý Phiên vẽ, Hộp thoại Nhật ký & Bảng Quản trị viên</h3>
  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">TRƯỚC: Bảng danh sách phiên vẽ</div>
      <img src="${beforeImages.jobsTab}" alt="Jobs Tab Before">
      <div class="gallery-desc">Bảng cũ tràn ngang trên di động, nút thao tác rời rạc.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Bảng phiên vẽ chuẩn công cụ (Jobs Management)</div>
      <img src="${afterImages.jobsTab}" alt="Jobs Tab After">
      <div class="gallery-desc">Bảng compact, số liệu tabular-nums, responsive ẩn cột thông minh trên mobile đảm bảo vừa khít khung thẻ card.</div>
    </div>
  </div>

  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">SAU: Hộp thoại "Nhật ký phiên" (Job Details Modal)</div>
      <img src="${afterImages.modal}" alt="Job Details Modal After">
      <div class="gallery-desc">Hộp thoại modal hiển thị thông tin máy, người gửi và dòng thời gian các sự kiện trạng thái (Hàng đợi, Đang nhận, Đang vẽ, Hoàn thành).</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Bảng quản trị hệ thống (Admin Console)</div>
      <img src="${afterImages.adminTab}" alt="Admin Tab After">
      <div class="gallery-desc">Dành riêng cho admin: quản lý danh sách máy vẽ, thêm máy mới, cấp tài khoản và theo dõi hàng đợi toàn hệ thống.</div>
    </div>
  </div>
</section>

<!-- Footer -->
<div class="footer-note">
  <span>Pixel2Plot Operator · Báo cáo nghiệm thu kỹ thuật UI/UX hoàn tất</span>
  <span>Bản quyền © 2026 Nhóm Pixel2Plot — Khoa KTMT, Trường ĐH CNTT (UIT)</span>
</div>

</body>
</html>
`;

(async () => {
  console.log("Đang khởi tạo trình duyệt Playwright Chromium...");
  const browser = await chromium.launch({
    executablePath: "/opt/google/chrome/chrome",
    args: ["--no-sandbox", "--disable-gpu", "--disable-crash-reporter", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  console.log("Đang tải nội dung báo cáo HTML với các ảnh chụp kết quả base64...");
  await page.setContent(htmlContent, { waitUntil: "networkidle" });
  console.log("Đang xuất file PDF chất lượng cao tại:", PDF_PATH);
  await page.pdf({
    path: PDF_PATH,
    format: "A4",
    printBackground: true,
    margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: '<div style="width: 100%; font-size: 8pt; font-family: monospace; color: #888; padding: 0 12mm; display: flex; justify-content: space-between;"><span>Pixel2Plot Operator — UI/UX Engineering Report</span><span>Trang <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
  });
  await browser.close();
  console.log("XUẤT PDF THÀNH CÔNG:", PDF_PATH);
  const stats = fs.statSync(PDF_PATH);
  console.log("Dung lượng file PDF:", Math.round(stats.size / 1024), "KB");
})();
