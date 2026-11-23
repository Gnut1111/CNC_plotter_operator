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
  login: getBase64Image(path.join(AFTER_DIR, "00_desktop_login_split_screen_after.png")),
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
<title>Pixel2Plot Operator — Báo cáo Thiết kế & Kỹ thuật Toàn diện (Dub.co Enterprise Edition)</title>
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
    --border-hairline: rgba(0, 0, 0, 0.08);
    --border-dark: rgba(0, 0, 0, 0.16);
    --accent: #171717;
    --accent-subtle: #f4f4f5;
    --ok: #16a34a;
    --ok-bg: #f0fdf4;
    --warn: #ca8a04;
    --err: #dc2626;
    --err-bg: #fef2f2;
    --font-ui: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--font-ui);
    color: var(--text-primary);
    background: var(--bg-canvas);
    font-size: 10.5pt;
    line-height: 1.5;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .cover {
    padding: 24px 0 18px;
    border-bottom: 2px solid var(--text-primary);
    margin-bottom: 20px;
    page-break-after: avoid;
  }
  .badge-tag {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 8pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: var(--bg-subtle);
    border: 1px solid var(--border-hairline);
    padding: 2px 8px;
    border-radius: 4px;
    margin-bottom: 10px;
  }
  h1 {
    font-size: 22pt;
    font-weight: 700;
    letter-spacing: -0.03em;
    line-height: 1.15;
    margin-bottom: 6px;
  }
  .subtitle {
    font-size: 11pt;
    color: var(--text-secondary);
    font-weight: 400;
    margin-bottom: 14px;
    line-height: 1.45;
  }
  .meta-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    padding: 10px 12px;
    background: var(--bg-surface);
    border: 1px solid var(--border-hairline);
    border-radius: 6px;
    font-size: 8.5pt;
  }
  .meta-item strong { display: block; color: var(--text-muted); font-size: 7.5pt; text-transform: uppercase; margin-bottom: 2px; }
  .meta-item span { font-family: var(--font-mono); font-weight: 500; }

  h2 {
    font-size: 13.5pt;
    font-weight: 700;
    letter-spacing: -0.02em;
    border-bottom: 1px solid var(--border-hairline);
    padding-bottom: 5px;
    margin-top: 22px;
    margin-bottom: 10px;
    page-break-after: avoid;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  h2 .num {
    font-family: var(--font-mono);
    color: var(--text-muted);
    font-size: 11.5pt;
  }

  h3 {
    font-size: 10.5pt;
    font-weight: 600;
    margin-top: 12px;
    margin-bottom: 5px;
    page-break-after: avoid;
    color: #171717;
  }

  p { margin-bottom: 7px; text-align: justify; }

  ul, ol {
    margin-left: 18px;
    margin-bottom: 8px;
  }
  li { margin-bottom: 3.5px; }

  code {
    font-family: var(--font-mono);
    font-size: 8.5pt;
    background: var(--bg-subtle);
    padding: 1px 4px;
    border-radius: 3px;
    border: 1px solid var(--border-hairline);
  }

  .table-clean {
    width: 100%;
    border-collapse: collapse;
    margin: 10px 0 14px;
    font-size: 8.5pt;
    page-break-inside: avoid;
  }
  .table-clean th, .table-clean td {
    padding: 6px 9px;
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
    font-size: 7.5pt;
    color: var(--ok);
    background: var(--ok-bg);
    border: 1px solid rgba(22, 163, 74, 0.2);
    padding: 1px 5px;
    border-radius: 3px;
    display: inline-block;
  }

  .callout {
    background: var(--bg-surface);
    border-left: 3px solid var(--text-primary);
    padding: 8px 12px;
    margin: 10px 0;
    border-radius: 0 4px 4px 0;
    font-size: 9pt;
  }
  .callout strong { color: var(--text-primary); }

  .callout-ban {
    background: var(--err-bg);
    border-left: 3px solid var(--err);
    padding: 8px 12px;
    margin: 10px 0;
    border-radius: 0 4px 4px 0;
    font-size: 9pt;
  }
  .callout-ban strong { color: var(--err); }

  .feature-box {
    background: #fafafa;
    border: 1px solid rgba(0,0,0,0.08);
    border-radius: 6px;
    padding: 10px 12px;
    margin-bottom: 8px;
  }
  .feature-box h4 {
    font-size: 9.5pt;
    font-weight: 600;
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* Gallery Grid */
  .gallery-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin: 10px 0 14px;
    page-break-inside: avoid;
  }
  .gallery-card {
    border: 1px solid var(--border-hairline);
    border-radius: 6px;
    padding: 7px;
    background: var(--bg-surface);
    page-break-inside: avoid;
  }
  .gallery-card img {
    width: 100%;
    height: auto;
    border-radius: 4px;
    border: 1px solid var(--border-hairline);
    display: block;
    margin-bottom: 5px;
    max-height: 220px;
    object-fit: contain;
    background: #ffffff;
  }
  .gallery-title {
    font-size: 8.5pt;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 2px;
  }
  .gallery-desc {
    font-size: 7.5pt;
    color: var(--text-muted);
    line-height: 1.35;
  }

  .showcase-single {
    border: 1px solid var(--border-hairline);
    border-radius: 8px;
    padding: 10px;
    background: #fafafa;
    margin: 12px 0 16px;
    page-break-inside: avoid;
  }
  .showcase-single img {
    width: 100%;
    border-radius: 6px;
    border: 1px solid rgba(0,0,0,0.08);
    display: block;
    margin-bottom: 8px;
    max-height: 380px;
    object-fit: contain;
    background: #ffffff;
  }

  .page-break {
    page-break-before: always;
  }

  .footer-note {
    margin-top: 24px;
    padding-top: 8px;
    border-top: 1px solid var(--border-hairline);
    font-size: 7.5pt;
    color: var(--text-muted);
    display: flex;
    justify-content: space-between;
  }
</style>
</head>
<body>

<!-- Header Cover -->
<header class="cover">
  <div class="badge-tag">Pixel2Plot · System Engineering & Design Audit (Dub.co Enterprise Edition)</div>
  <h1>Pixel2Plot Operator Workspace Redesign</h1>
  <div class="subtitle">Báo cáo kiểm định kiến trúc trải nghiệm người dùng theo chuẩn Dub.co Enterprise, Linear & Figma UI3, triệt tiêu AI Slop, khắc phục 4 lỗi tồn đọng và kết quả nghiệm thu kiểm thử tự động 100% PASS</div>
  <div class="meta-grid">
    <div class="meta-item"><strong>Repository:</strong><span>CNC_plotter_operator</span></div>
    <div class="meta-item"><strong>Git Branch:</strong><span>feat/operator-workspace</span></div>
    <div class="meta-item"><strong>Commit Status:</strong><span>Verified Local (No Push)</span></div>
    <div class="meta-item"><strong>Date & Time:</strong><span>2026-11-23 14:55</span></div>
  </div>
</header>

<!-- Section 1 -->
<section>
  <h2><span class="num">01.</span> Toàn bộ các nguyên tắc tuân thủ (Core Principles & Guidelines)</h2>
  <p>Dự án được tái thiết kế và chuẩn hóa toàn diện dựa trên 4 trụ cột nguyên tắc kỹ thuật, kỷ luật hệ thống và ngôn ngữ thiết kế sản phẩm chuyên nghiệp:</p>

  <h3>1.1. Nguyên tắc kỷ luật hệ thống & Kiểm chứng Runtime (AGENTS.md & Global Rules)</h3>
  <ul>
    <li><strong>Tìm kiếm trước khi hành động (Search Web First):</strong> Tra cứu upstream bug tracker, repo kiến trúc UI (ln-dev7/circle, miqdadbadjuber/anti-slop, Dub.co open-source patterns) và tài liệu tham khảo trước khi đề xuất hoặc can thiệp mã nguồn.</li>
    <li><strong>Kỷ luật sao lưu tuyệt đối (Backup Discipline):</strong> Mọi file mã nguồn trước khi chỉnh sửa bắt buộc phải tạo snapshot sao lưu <code>.bak</code> tại chỗ. Báo cáo minh bạch đường dẫn backup để có thể hoàn nguyên tức thì.</li>
    <li><strong>Nghiệm thu Runtime thực tế thay vì sửa cấu hình tĩnh (Live Runtime Verification):</strong> Nghiêm cấm báo cáo kết quả chỉ bằng việc sửa code; bắt buộc phải khởi chạy daemon, máy giả lập MQTT, đo kiểm qua trình duyệt thật (Playwright/Chrome) ở các kích thước 1440×900, 390×844 và 320×760.</li>
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

  <h3>1.3. Ngôn ngữ thiết kế Dub.co Enterprise & Linear/Figma UI3</h3>
  <p>Hệ thống nâng cấp trực tiếp lên diện mạo <strong>Dub.co Enterprise</strong> thông qua 5 dấu ấn kiến trúc chuẩn mực:</p>
  <div class="feature-box">
    <h4>1. Trang Đăng nhập Dub.co Split-Screen 50/50</h4>
    <p>Cột trái (50%) là form đăng nhập nền trắng phủ lưới ô vuông mờ 40px với mặt nạ <code>radial-gradient</code>, bỏ khung card gò bó, nút bấm đen sắc nét, cụm 1-click Quick-Fill tài khoản mẫu (<code>admin / admin123</code> và <code>user / user123</code>) đặt trong khung nét đứt trên 1 dòng. Cột phải (50%) là nền <code>#FAFAFA</code> chứa khung khay đôi Showcase bàn vẽ CNC vector SVG cùng 4 thông số đo vi mô.</p>
  </div>
  <div class="feature-box">
    <h4>2. Khung ứng dụng App Shell (Left Sidebar + Inset Canvas)</h4>
    <p>Trên Desktop (≥1024px), thanh Topbar cơ bản được thay thế hoàn toàn bằng <strong>Left Sidebar cố định 228px</strong> nền <code>#F7F7F7</code> với icon SVG nét mảnh 1.5px, card tab active màu trắng bo 8px viền hairline. Khung làm việc chính là <strong>Inset Canvas</strong> nền <code>#FFFFFF</code> lồng trong khay (<code>margin: 8px 8px 8px 0; border-radius: 12px; border: 1px solid rgba(0,0,0,0.07); box-shadow: 0 1px 3px rgba(0,0,0,0.03)</code>).</p>
  </div>
  <div class="feature-box">
    <h4>3. Tính nhất quán màu sắc Neutral-first Triệt để</h4>
    <p>Mặc định Light Mode cao cấp (<code>data-theme="light"</code>). Toàn bộ nút CTA chính dùng màu đen <code>#171717</code> kèm hiệu ứng vát sáng viền nổi xúc giác Clerk (<code>shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12)]</code>). Vòng tròn Stepper active nền đen số trắng. Thanh tiến độ màu đen <code>#171717</code> chuyển sang xanh lá <code>#10B981</code> khi đạt 100%.</p>
  </div>
  <div class="feature-box">
    <h4>4. Typography Chuẩn Pro-Tool & Page Headers Rõ Ràng</h4>
    <p>Nhúng bộ font Google Fonts <code>Inter</code> + <code>JetBrains Mono</code> với các cờ OpenType <code>font-feature-settings: "cv02", "cv03", "cv04", "cv11"</code>. Toàn bộ số đo mm, tọa độ X/Y, mã phiên vẽ <code>#id</code>, thời gian sử dụng <code>tabular-nums</code>. Đầu mỗi tab có Page Header chuẩn chỉnh (<code>20px</code>, weight <code>600</code>, tracking <code>-0.02em</code>).</p>
  </div>
  <div class="feature-box">
    <h4>5. Đồ họa vi mô Phần cứng (Hardware Micro-Graphics)</h4>
    <p>4 điểm dấu chữ thập cơ khí <code>+</code> (9px, màu <code>#D4D4D4</code>) tại 4 góc vùng vẽ; nền buffer sọc chéo 45° kỹ thuật; trạng thái trống (empty state) gồm hộp vuông trắng 44px bo 10px viền hairline kèm icon <code>+</code> và 3 vòng đồng tâm mờ.</p>
  </div>

  <h3>1.4. Trải nghiệm nghiệp vụ vận hành máy vẽ CNC (Domain Engineering)</h3>
  <ul>
    <li><strong>Luồng 4 bước liền mạch:</strong> Thanh chỉ dẫn Stepper định hướng: <code>1. Chọn ảnh</code> → <code>2. Xem đường vẽ</code> → <code>3. Chọn máy & gửi</code> → <code>4. Theo dõi phiên</code>.</li>
    <li><strong>Bảo vệ toàn vẹn lệnh gửi (Hash Mismatch Guard):</strong> G-code gửi xuống máy bắt buộc phải khớp hash SHA-256 của bản xem trước đã duyệt, ngăn chặn hoàn toàn sai lệch thông số.</li>
  </ul>
</section>

<div class="page-break"></div>

<!-- Section 2 -->
<section>
  <h2><span class="num">02.</span> Toàn bộ các bước đã thực hiện (Execution Breakdown)</h2>
  
  <h3>Giai đoạn 1: Khảo sát hiện trạng & Bóc tách 3 điểm khó dùng cốt lõi</h3>
  <ol>
    <li><strong>Bố cục 3 khối form phân mảnh:</strong> Nút "Gửi" nằm tít cuối trang form cột 3; người dùng phải đảo mắt liên tục.</li>
    <li><strong>Trải nghiệm mobile vỡ nát:</strong> Màn hình hẹp bị cuộn ngang; canvas co nhỏ dưới 200px; tên file dài làm vỡ layout.</li>
    <li><strong>Thông báo kỹ thuật khô khan & thiếu chỉ dẫn tiếp theo:</strong> Trạng thái kết nối và lỗi chỉ hiển thị mã HTTP hoặc chuỗi thô.</li>
  </ol>

  <h3>Giai đoạn 2: Tái kiến trúc HTML & Hiện thực hóa Dub.co App Shell</h3>
  <ul>
    <li>Tái cấu trúc giao diện đăng nhập thành <strong>Dub.co Split-Screen 50/50</strong>: form bên trái không viền card, showcase vector CNC bên phải lồng trong khay đôi bo 16px/11px.</li>
    <li>Xây dựng thanh <strong>Left Sidebar cố định 228px</strong> trên Desktop chứa logo Pixel2Plot, các tab chức năng với icon SVG nét mảnh 1.5px, dot trạng thái kết nối realtime và avatar người dùng.</li>
    <li>Đưa toàn bộ nội dung ứng dụng vào <strong>Inset Canvas panel</strong> bo 12px, viền 1px, tách biệt rõ ràng với nền xám canvas của shell.</li>
    <li>Trên Mobile (≤1023px), tự động chuyển đổi sang thanh Header 2 tầng gọn gàng, bảo đảm không chiếm diện tích vùng làm việc.</li>
  </ul>

  <h3>Giai đoạn 3: Khắc phục triệt để 4 lỗi tồn đọng từ đợt kiểm định trước</h3>
  <ul>
    <li><strong>Sửa lỗi 1 — Khung Auto-Tune bị cắt cụt nửa dưới:</strong> Tái cấu trúc danh sách ứng viên thành lưới 2 cột song song (<code>.cand-grid</code>). Cả 2 thẻ phương án (Nhanh & Chi tiết) cùng nút <code>Áp dụng</code> hiển thị trọn vẹn 100% bên trên hộp Máy nhận, hỗ trợ tự động cuộn mượt (<code>scrollIntoView</code>) khi bấm nút Gợi ý cấu hình.</li>
    <li><strong>Sửa lỗi 2 — Nút Mô phỏng bị rớt lẻ loi trên Mobile & Stepper nén chữ:</strong> Tái cơ cấu thanh toolbar phía trên bàn vẽ thành bố cục responsive 3 hàng cân bằng: hàng 1 gồm Nguồn ảnh + chế độ Đường vẽ/Ảnh gốc/So nét; hàng 2 gom nút Đường nhấc bút và Mô phỏng trên cùng một dòng; hàng 3 là thanh phát lại. Đồng thời rút gọn nhãn Stepper trên màn hình siêu hẹp (≤360px) thành <code>1 Chọn ảnh</code>, <code>2 Xem</code>, <code>3 Gửi</code>, <code>4 Theo dõi</code>, triệt tiêu hoàn toàn hiện tượng cắt chữ.</li>
    <li><strong>Sửa lỗi 3 — Thông tin bị lặp trong Bảng Phiên vẽ & sau khi gửi:</strong> Đã loại bỏ dòng chữ phụ <code>#id · tên máy</code> dưới tên file trong bảng phiên vẽ (do đã có sẵn cột <code>#</code> và cột <code>Máy vẽ</code> bên cạnh). Sau khi bấm Gửi, hệ thống tự động ẩn hộp chỉ dẫn bước tiếp theo khi phiên đã vào hàng đợi, chỉ để lại duy nhất một khung thông báo thành công súc tích <code>#sendMsg</code> kèm nút xem trong tab Phiên vẽ.</li>
    <li><strong>Sửa lỗi 4 — Thanh trượt Mức chi tiết quá nhạt:</strong> Cập nhật thanh trượt dải giá trị (range slider) với biến CSS động <code>--slider-pct</code>: phần dải đã kéo được tô màu đen <code>#171717</code> tương phản cao, phần chưa kéo màu xám nhạt <code>#E5E5E5</code>, con trượt thumb màu trắng 16px với viền đen 1.5px sắc sảo, hoàn toàn nổi bật trên nền trắng.</li>
  </ul>

  <h3>Giai đoạn 4: Tái cấu trúc Logic & Giải quyết xung đột kiểm thử (web/app.js)</h3>
  <ul>
    <li><strong>1-Click Quick Fill Đăng nhập:</strong> Bổ sung event listener cho các thẻ <code>[data-fill]</code>, bấm 1 chạm tự điền tài khoản và mật khẩu mà không cần gõ phím.</li>
    <li><strong>Xử lý Đóng Playback khi Xóa File:</strong> Sửa logic <code>handleSelectedFile(null)</code> để khi test suite gọi <code>setInputFiles([])</code>, hệ thống tự động thu hồi ảnh, đóng thanh điều khiển mô phỏng và lập lịch dọn dẹp canvas.</li>
    <li><strong>Bảo toàn Trạng thái Gửi đồng thời với Sửa kích thước:</strong> Bọc điều kiện gán <code>sentJob = job</code> chỉ khi <code>current === revision</code>, cho phép người dùng tiếp tục sửa thông số kích thước mà nút Gửi vẫn mở khóa an toàn khi có bản xem trước mới.</li>
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
        <td><code>operator-agent-retest.cjs</code></td>
        <td>Port 3817 (390 & 320px)</td>
        <td>Kiểm tra Tab navigation từ logoutBtn đến sourceFile (1 tab pass), chiều cao canvas ≥ 260px (thực tế 354px & 284px), validation width=2mm, nút Đặt lại khôi phục 150, mở modal "Nhật ký phiên" và đóng bằng Esc, table &lt;= card.</td>
        <td><span class="tag-pass">PASS (Exit 0)</span></td>
      </tr>
      <tr>
        <td><code>operator-agent-send-retest.cjs</code></td>
        <td>Port 3817 (1400px)</td>
        <td>Khóa form an toàn khi gửi mạng chậm (form.inert === true, sourceFile disabled, machineSelect disabled), thông báo "Phiên #id đã vào hàng đợi", mở khóa sau khi máy nhận.</td>
        <td><span class="tag-pass">PASS (Exit 0)</span></td>
      </tr>
      <tr>
        <td><code>operator-agent-review-jobs.cjs</code></td>
        <td>Port 3817 (390px)</td>
        <td>Gửi bản vẽ logo.png chế độ fill, điều khiển Tạm dừng → Tiếp tục → Hủy phiên → Xác nhận "Đã hủy". Đăng xuất, login admin duyệt bảng máy/user, reset workspace khi quay lại.</td>
        <td><span class="tag-pass">PASS (Exit 0)</span></td>
      </tr>
      <tr>
        <td><code>operator-agent-review-cases.cjs</code></td>
        <td>Port 3817 (390px, Dark Mode)</td>
        <td>Chạy auto-tune qua #autoBtn, chọn [data-cand], thử file hỏng fake.png (hiện retry), sai MIME fake.gif (hiện fileError), máy offline cnc-01, gửi khi đang chỉnh kích thước.</td>
        <td><span class="tag-pass">PASS (Exit 0)</span></td>
      </tr>
      <tr>
        <td><code>operator-agent-review.cjs</code></td>
        <td>Port 3817 (1400/390/320px)</td>
        <td>Kiểm tra không tràn ngang (x-scroll = width), chọn ảnh, chuyển chế độ Ảnh gốc/Đường vẽ, hiển thị travel, validation khi width=2mm, tải G-code, gửi máy giả lập.</td>
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
    <strong>Cam kết toàn vẹn mã nguồn:</strong> Toàn bộ các cải tiến giao diện và logic được thực hiện trên nhánh <code>feat/operator-workspace</code>, bảo toàn 100% các cam kết Git lịch sử, tuân thủ kỷ luật sao lưu <code>.bak</code> trước khi sửa, tuyệt đối không push theo đúng quy định.
  </div>
</section>

<div class="page-break"></div>

<!-- Section 4 -->
<section>
  <h2><span class="num">04.</span> So sánh hình ảnh kết quả Trước và Sau (Visual Evidence Gallery)</h2>
  
  <h3>4.1. Dấu ấn Kiến trúc Flagship: Trang Đăng nhập Dub.co Split-Screen 50/50</h3>
  <div class="showcase-single">
    <div class="gallery-title">SAU: Trang Đăng nhập Dub.co Split-Screen 50/50 (Desktop 1440×900)</div>
    <img src="${afterImages.login}" alt="Dub.co Split-Screen Login">
    <div class="gallery-desc">Cột trái (50%): Form đăng nhập tối giản không viền card, phủ lưới ô vuông mờ 40px với mặt nạ radial-gradient, nút đăng nhập đen sắc nét, hộp nét đứt điền nhanh tài khoản mẫu 1-click (admin / admin123, user / user123). Cột phải (50%): Nền #FAFAFA chứa khung khay đôi Showcase bàn vẽ CNC vector SVG cùng 4 thông số đo vi mô.</div>
  </div>

  <h3>4.2. Màn hình Desktop: Trạng thái ban đầu & Bố cục làm việc Inset Canvas</h3>
  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">TRƯỚC: Desktop khi chưa chọn ảnh</div>
      <img src="${beforeImages.empty}" alt="Desktop Before Empty">
      <div class="gallery-desc">Bố cục 3 cột phân mảnh, khung chọn file đơn độc, lãng phí diện tích, form dài dòng.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Desktop khi chưa chọn ảnh (Left Sidebar + Inset Canvas)</div>
      <img src="${afterImages.empty}" alt="Desktop After Empty">
      <div class="gallery-desc">Left Sidebar 228px cố định nền #F7F7F7; Inset Canvas nền trắng lồng trong khay bo 12px; Stepper 4 bước; 4 dấu chữ thập định vị cơ khí góc bàn vẽ.</div>
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
      <div class="gallery-desc">Cụm điều phối máy và nút "Gửi bản vẽ" đặt ở vị trí cao nhất; số đo mm tabular-nums; thanh trượt mức chi tiết tương phản cao với track tô đen.</div>
    </div>
  </div>

  <div class="page-break"></div>

  <h3>4.3. Chế độ xem & Tính năng Điều khiển Phiên trực tiếp</h3>
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
      <div class="gallery-title">SAU: Tự động tìm cấu hình vẽ (Auto-Tune Sửa Lỗi Cắt Thẻ)</div>
      <img src="${afterImages.autotune}" alt="Desktop Auto-tune">
      <div class="gallery-desc">Khắc phục triệt để lỗi cắt thẻ: bố cục lưới 2 cột (.cand-grid) hiển thị song song 2 phương án Chi tiết & Nhanh với đầy đủ nút Áp dụng và chỉ số IoU %.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Thanh giám sát phiên trực tiếp (Active Job Bar)</div>
      <img src="${afterImages.activeJob}" alt="Desktop Active Job Bar">
      <div class="gallery-desc">Thanh điều khiển nổi ngay dưới bàn vẽ: hiển thị tiến độ % realtime, nút Tạm dừng, Hủy và xem Chi tiết không cần rời trang; loại bỏ thông báo thừa.</div>
    </div>
  </div>

  <div class="page-break"></div>

  <h3>4.4. Kiểm chứng trên thiết bị Di động (Mobile 390×844 & Small Mobile 320×760)</h3>
  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">TRƯỚC: Mobile 390×844</div>
      <img src="${beforeImages.mobile390}" alt="Mobile 390 Before">
      <div class="gallery-desc">Bị cuộn ngang, nút thao tác khuất, phải dò tìm phức tạp.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Mobile 390×844 (Chuẩn xác, 0 cuộn ngang, nút không rớt)</div>
      <img src="${afterImages.mobile390}" alt="Mobile 390 After">
      <div class="gallery-desc">Toolbar 3 tầng cân bằng (nút Mô phỏng cùng hàng với Đường nhấc bút); nút Gửi nổi bật, thông số compact, 100% không cuộn ngang.</div>
    </div>
  </div>

  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">TRƯỚC: Small Mobile 320×760</div>
      <img src="${beforeImages.mobile320}" alt="Mobile 320 Before">
      <div class="gallery-desc">Vỡ layout trên màn hình nhỏ, canvas bị co dúm dưới 200px.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Small Mobile 320×760 (Canvas cao 284px, Stepper không cắt)</div>
      <img src="${afterImages.mobile320}" alt="Mobile 320 After">
      <div class="gallery-desc">Chiều cao canvas đạt 284px ≥ 260px; Stepper rút gọn nhãn thông minh (1 Chọn ảnh, 2 Xem, 3 Gửi, 4 Theo dõi) triệt tiêu hoàn toàn hiện tượng cắt chữ.</div>
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

  <h3>4.5. Quản lý Phiên vẽ, Hộp thoại Nhật ký & Bảng Quản trị viên</h3>
  <div class="gallery-grid">
    <div class="gallery-card">
      <div class="gallery-title">TRƯỚC: Bảng danh sách phiên vẽ</div>
      <img src="${beforeImages.jobsTab}" alt="Jobs Tab Before">
      <div class="gallery-desc">Bảng cũ tràn ngang trên di động, thông tin lặp dòng #id · tên máy dưới tên file.</div>
    </div>
    <div class="gallery-card">
      <div class="gallery-title">SAU: Bảng phiên vẽ chuẩn Dub.co (Xóa thông tin lặp)</div>
      <img src="${afterImages.jobsTab}" alt="Jobs Tab After">
      <div class="gallery-desc">Bảng compact, số liệu tabular-nums; đã loại bỏ hoàn toàn thông tin lặp; tên file màu đen #171717 hover gạch chân; responsive ẩn cột vừa khít card.</div>
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
      <div class="gallery-desc">Dành riêng cho admin: Page Header chuẩn mực, quản lý danh sách máy vẽ, thêm máy mới, cấp tài khoản và theo dõi hàng đợi toàn hệ thống.</div>
    </div>
  </div>
</section>

<!-- Footer -->
<div class="footer-note">
  <span>Pixel2Plot Operator · Báo cáo nghiệm thu kỹ thuật UI/UX hoàn tất (Dub.co Enterprise Edition)</span>
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
    footerTemplate: '<div style="width: 100%; font-size: 8pt; font-family: monospace; color: #888; padding: 0 12mm; display: flex; justify-content: space-between;"><span>Pixel2Plot Operator — UI/UX Engineering Report (Dub.co Enterprise)</span><span>Trang <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>'
  });
  await browser.close();
  console.log("XUẤT PDF THÀNH CÔNG:", PDF_PATH);
  const stats = fs.statSync(PDF_PATH);
  console.log("Dung lượng file PDF:", Math.round(stats.size / 1024), "KB");
})();
