// =================================================================================
// DITHERTONE - 核心腳本
// =================================================================================

// === 1. DOM 元素獲取 ===
// ---------------------------------------------------------------------------------
// 將所有需要操作的 HTML 元素在腳本開始時一次性獲取，便於管理。
const imageUpload = document.getElementById('image-upload');
const ditherStyleSelect = document.getElementById('dither-style');
const ditherStrength = document.getElementById('dither-strength');
const strengthValue = document.getElementById('strength-value');
const colorStartInput = document.getElementById('color-start');
const colorEndInput = document.getElementById('color-end');
const colorLevels = document.getElementById('color-levels');
const levelsValue = document.getElementById('levels-value');
const bloomToggle = document.getElementById('bloom-toggle');
const bloomIntensity = document.getElementById('bloom-intensity');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const downloadBtn = document.getElementById('download-btn');
const toggleViewBtn = document.getElementById('toggle-view-btn'); 
const placeholderText = document.getElementById('placeholder-text');
const canvasWrapper = document.getElementById('canvas-wrapper');


// === 2. 離屏渲染與狀態管理 ===
// ---------------------------------------------------------------------------------
// 創建內存中的畫布，用於多通道渲染，避免直接在主畫布上反覆操作，提高性能和靈活性。
const ditherCanvas = document.createElement('canvas');
const ditherCtx = ditherCanvas.getContext('2d');
const glowCanvas = document.createElement('canvas');
const glowCtx = glowCanvas.getContext('2d');

let originalImage = null; // 存儲用戶上傳的原始圖片對象
let isProcessing = false; // 處理狀態旗標，防止在處理過程中重複觸發渲染
let showOriginal = false; // 控制顯示原始圖或效果圖的狀態


// === 3. 預定義資料 ===
// ---------------------------------------------------------------------------------
// 存儲不會改變的數據，如抖動矩陣。
const ditherMatrices = {
    bayer: [
        [ 0,  8,  2, 10], [12,  4, 14,  6], [ 3, 11,  1,  9], [15,  7, 13,  5]
    ],
    crosshatch: [
        [12,  5,  6, 13], [ 4, 11, 10,  7], [ 8,  9,  3,  0], [ 1,  2, 15, 14]
    ]
};

// === 4. 事件監聽器設定 ===
// ---------------------------------------------------------------------------------
// 將所有事件綁定集中管理。
function setupEventListeners() {
    imageUpload.addEventListener('change', handleImageUpload);
    downloadBtn.addEventListener('click', downloadImage);
    toggleViewBtn.addEventListener('click', toggleView);

    // 將所有會觸發重繪的控制項放在一個陣列中統一監聽
    const controls = [
        ditherStyleSelect, colorStartInput, colorEndInput, ditherStrength, 
        colorLevels, bloomToggle, bloomIntensity
    ];
    controls.forEach(control => {
        control.addEventListener('input', requestProcessImage);
    });

    // 為需要顯示數值的滑桿單獨添加事件
    ditherStrength.addEventListener('input', () => {
        strengthValue.textContent = parseFloat(ditherStrength.value).toFixed(1);
    });
    colorLevels.addEventListener('input', () => {
        levelsValue.textContent = colorLevels.value;
    });
    bloomToggle.addEventListener('change', () => {
        bloomIntensity.disabled = !bloomToggle.checked;
    });
}
setupEventListeners(); // 執行事件綁定

// === 5. 首頁展示邏輯 (Showcase) ===
// ---------------------------------------------------------------------------------
function initShowcase() {
    const showcaseImages = document.querySelectorAll('.showcase-background img');
    if (showcaseImages.length === 0) return;

    let currentIndex = 0;
    setInterval(() => {
        showcaseImages[currentIndex].classList.remove('is-visible');
        currentIndex = (currentIndex + 1) % showcaseImages.length;
        showcaseImages[currentIndex].classList.add('is-visible');
    }, 3000); // 每 3 秒切換一次
}

// === 6. 核心流程控制 ===
// ---------------------------------------------------------------------------------
// 這些函式負責控制整個應用的流程，如圖片上傳和渲染請求。

/**
 * 處理用戶上傳圖片的事件。
 * @param {Event} e - 文件輸入事件對象
 */
function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (event) => {
        originalImage = new Image();
        originalImage.onload = () => {
            placeholderText.style.display = 'none';
            downloadBtn.disabled = false;
            toggleViewBtn.disabled = false; // 啟用切換按鈕
            showOriginal = false; // 默認顯示效果圖
            toggleViewBtn.textContent = 'VIEW ORIGINAL';
            requestProcessImage();
        };
        originalImage.src = event.target.result;
    };
    reader.readAsDataURL(file);
}

/**
 * 請求處理圖片。
 * 這是所有控制項改變時觸發的入口點。
 * 使用 isProcessing 旗標和 setTimeout 來防止UI阻塞和重複渲染。
 */
function requestProcessImage() {
    if (!originalImage || isProcessing) return; // 如果沒有圖片或正在處理，则忽略
    isProcessing = true;
    canvasWrapper.classList.add('PROCESSING'); // 顯示載入中動畫

    // 使用 setTimeout 將耗時操作推遲到下一個事件循環，
    // 確保瀏覽器有時間渲染 "processing" 的 CSS 樣式。
    setTimeout(() => {
        try {
            applyDitherAndBloomPipeline();
        } catch (error) {
            console.error("ERROR WHILE PROCESSING:", error);
        } finally {
            canvasWrapper.classList.remove('PROCESSING'); // 隱藏載入中動畫
            isProcessing = false;
        }
    }, 10);
}

// 切換視圖的處理函式
function toggleView() {
    if (!originalImage) return;
    showOriginal = !showOriginal; // 翻轉狀態
    toggleViewBtn.textContent = showOriginal ? 'VIEW AFTEREFFECT' : 'VIEW ORIGINAL';
    // 觸發一次重繪， compositeFinalImage 會根據新狀態繪製
    compositeFinalImage(glowCanvas); // 直接調用 composite，因為抖動和輝光層已在內存中
}

// === 7. 核心演算法管線 (Rendering Pipeline) ===
// ---------------------------------------------------------------------------------
// 這是圖像處理的核心，採用多通道渲染架構。

/**
 * 總指揮函式，按順序調用各個渲染通道。
 */
function applyDitherAndBloomPipeline() {
    // Pass 1: Dither Pass - 產生基礎的抖動圖像
    renderDitherPass();

    // Pass 2 & 3: Bloom Pass - 如果啟用，則產生光暈圖層
    let glowLayer = null;
    if (bloomToggle.checked) {
        glowLayer = renderBloomPass();
    }

    // Pass 4: Composite Pass - 將所有圖層合併到最終畫布上
    compositeFinalImage(glowLayer);
}

/**
 * [Pass 1] 抖動通道：
 * 執行核心抖動演算法，並將結果繪製到離屏的 ditherCanvas 上。
 */
function renderDitherPass() {
    ditherCanvas.width = originalImage.width;
    ditherCanvas.height = originalImage.height;
    ditherCtx.drawImage(originalImage, 0, 0);

    const imageData = ditherCtx.getImageData(0, 0, ditherCanvas.width, ditherCanvas.height);
    const data = imageData.data;
    
    // 從 UI 獲取所有相關參數
    const style = ditherStyleSelect.value;
    const strength = parseFloat(ditherStrength.value);
    const levels = parseInt(colorLevels.value);
    const colorStart = hexToRgb(colorStartInput.value) || { r: 0, g: 0, b: 0 };
    const colorEnd = hexToRgb(colorEndInput.value) || { r: 0, g: 0, b: 0 };
    const levelsMinusOne = levels <= 1 ? 1 : levels - 1;

    // 遍歷每個像素進行處理
    for (let i = 0; i < data.length; i += 4) {
        const gray = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
        const x = (i / 4) % ditherCanvas.width;
        const y = Math.floor((i / 4) / ditherCanvas.width);
        let finalLevelIndex;

        // 根據選擇的風格執行對應的抖動算法
        switch (style) {
            case 'bayer': {
                const bayerScale = 4; // 顆粒放大倍數
                const matrix = ditherMatrices.bayer;
                const scaledX = Math.floor(x / bayerScale);
                const scaledY = Math.floor(y / bayerScale);
                const threshold = (matrix[scaledY % 4][scaledX % 4] / 16 - 0.5) * (255 / levels);
                const ditheredGray = gray + threshold * strength;
                finalLevelIndex = Math.round(ditheredGray / 255 * levelsMinusOne);
                break;
            }
            case 'crosshatch': {
                const matrix = ditherMatrices.crosshatch;
                const threshold = (matrix[y % 4][x % 4] / 16 - 0.5) * (255 / levels);
                const ditheredGray = gray - threshold * strength; // 注意這裡是 "-"
                finalLevelIndex = Math.round(ditheredGray / 255 * levelsMinusOne);
                break;
            }
            case 'halftone': {
                const safeStrength = strength > 0 ? strength : 0.01;
                const cellSize = 10 / safeStrength;
                const baseLevelIndex = Math.floor(gray / 256 * levels);
                const nextLevelRatio = (gray / 256 * levels) - baseLevelIndex;
                const halfCell = cellSize / 2;
                const dist = Math.sqrt(Math.pow(x % cellSize - halfCell, 2) + Math.pow(y % cellSize - halfCell, 2));
                const radius = nextLevelRatio * halfCell * 0.8;
                finalLevelIndex = (dist > radius) ? baseLevelIndex : baseLevelIndex + 1;
                break;
            }
            case 'contour': {
                const stepSize = 255 / levels;
                const frequency = 0.2 * strength;
                const wave = Math.sin(y * frequency + gray / (stepSize * 1.5)) * (stepSize / 2);
                const ditheredGray = gray + wave;
                finalLevelIndex = Math.round(ditheredGray / 255 * levelsMinusOne);
                break;
            }
        }
        
        // 進行顏色量化並上色
        finalLevelIndex = Math.max(0, Math.min(levelsMinusOne, finalLevelIndex));
        const quantizedRatio = (levelsMinusOne > 0) ? finalLevelIndex / levelsMinusOne : 0;
        const finalColor = lerpColor(colorStart, colorEnd, quantizedRatio);
        
        data[i] = finalColor.r;
        data[i + 1] = finalColor.g;
        data[i + 2] = finalColor.b;
    }
    // 將處理完的像素數據寫回離屏畫布
    ditherCtx.putImageData(imageData, 0, 0);
}

/**
 * [Pass 2 & 3] 輝光通道：
 * 提取高光並進行模糊處理，返回一個包含光暈效果的離屏畫布 (glowCanvas)。
 * @returns {HTMLCanvasElement} - 包含光暈圖層的畫布。
 */
function renderBloomPass() {
    glowCanvas.width = originalImage.width;
    glowCanvas.height = originalImage.height;

    // --- Pass 2: 高光提取 ---
    const threshold = 180; // 亮度閾值，高於此值的像素才會發光
    const imageData = ditherCtx.getImageData(0, 0, ditherCanvas.width, ditherCanvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
        if (lum < threshold) {
            data[i+3] = 0; // 將不夠亮的像素的 Alpha 值設為 0，使其完全透明
        }
    }
    glowCtx.putImageData(imageData, 0, 0);

    // --- Pass 3: 模糊處理 ---
    const intensity = parseFloat(bloomIntensity.value);
    if (intensity > 0) {
        glowCtx.filter = `blur(${intensity}px)`;
        // 將畫布"畫到自己身上"是應用 filter 的標準技巧
        glowCtx.drawImage(glowCanvas, 0, 0);
        glowCtx.filter = 'none'; // 操作完成後立即清除 filter，以免影響後續繪圖
    }

    return glowCanvas;
}

/**
 * [Pass 4] 合成通道：
 * 將基礎抖動圖層 (ditherCanvas) 和光暈圖層 (glowLayer) 合併到最終可見的畫布上。
 * @param {HTMLCanvasElement | null} glowLayer - 包含光暈效果的畫布，如果禁用則為 null。
 */
function compositeFinalImage(glowLayer) {
    canvas.width = originalImage.width;
    canvas.height = originalImage.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 根據狀態決定繪製內容
    if (showOriginal) {
        // 狀態為真，繪製原始圖片
        ctx.drawImage(originalImage, 0, 0);
    } else {
        // 狀態為假，執行正常的合成流程 // 1. 繪製基礎的抖動圖像 (使用默認混合模式)
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(ditherCanvas, 0, 0);

         // 2. 如果有光暈圖層，以 "加亮" 模式疊加
        if (bloomToggle.checked && glowLayer) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.drawImage(glowLayer, 0, 0);
        }

        // 恢復默認混合模式，這是一個好習慣
        ctx.globalCompositeOperation = 'source-over';
    }
}
    
// === 8. 輔助函式 ===
// ---------------------------------------------------------------------------------
// 提供顏色轉換、線性插值和圖片下載等工具函式。

/**
 * 將 HEX 顏色字符串轉換為 RGB 物件。
 * @param {string} hex - 例如 "#RRGGBB"
 * @returns {{r: number, g: number, b: number} | null}
 */
function hexToRgb(hex) {
    if (!hex) return null;
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

/**
 * 在兩個顏色之間進行線性插值。
 * @param {{r,g,b}} a - 起始顏色
 * @param {{r,g,b}} b - 結束顏色
 * @param {number} amount - 插值比例 (0.0 to 1.0)
 * @returns {{r,g,b}} - 計算出的中間顏色
 */
function lerpColor(a, b, amount) {
    const r = a.r + amount * (b.r - a.r);
    const g = a.g + amount * (b.g - a.g);
    const finalB = a.b + amount * (b.b - a.b);
    return { r, g, b: finalB };
}

/**
 * 觸發瀏覽器下載當前畫布上的圖像。
 */
function downloadImage() {
    if (!originalImage) return;
    const image = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = image;
    link.download = 'dithertone-export.png';
    link.click();
}

// === 9. 初始化 ===
// ---------------------------------------------------------------------------------
// 確保在腳本末尾執行事件綁定和首頁動畫初始化
setupEventListeners();
