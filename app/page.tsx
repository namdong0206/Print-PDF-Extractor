'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import NextImage from 'next/image';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Upload, 
  Layout, 
  ChevronLeft, 
  ChevronRight, 
  Maximize2, 
  FileText, 
  Image as ImageIcon, 
  Layers, 
  Scissors,
  Info,
  CheckCircle2,
  Copy,
  Loader2,
  AlertCircle,
  Box
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseNewspaperLayout } from '@/lib/layoutService';
import { ArticleRegion, BoundingBox } from '@/lib/types';
import { segmentRegions, Region, groupBoxesByArticleRegion } from '@/lib/segmentationService';
import { extractTextBlocksWithMetadata, extractArticlesMultimodal, TextBlock, Article, mergeArticles } from '@/lib/geminiProcessor';
import { processArticleContent } from '@/lib/textProcessor';

// Dynamic imports for browser-only libraries
// We'll load pdfjs inside the component to avoid global state issues

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-[#FDFCFB] p-6">
          <div className="bg-white p-8 rounded-2xl border border-red-100 shadow-xl max-w-md w-full text-center">
            <AlertCircle className="text-red-500 mx-auto mb-4" size={48} />
            <h2 className="text-xl font-bold text-gray-900 mb-2">Đã có lỗi xảy ra</h2>
            <p className="text-sm text-gray-500 mb-6">Hệ thống gặp sự cố khi xử lý yêu cầu của bạn. Vui lòng thử lại sau.</p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full bg-[#1A1A1A] text-white py-3 rounded-xl font-bold hover:bg-black transition-colors"
            >
              Tải lại trang
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

function CopyButton({ text, label, variant = 'icon' }: { text: string; label: string; variant?: 'icon' | 'square' }) {
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  if (variant === 'square') {
    return (
      <button
        onClick={handleCopy}
        className={cn(
          "w-full py-3 px-4 rounded-xl font-bold transition-all flex items-center justify-center gap-2",
          isCopied ? "bg-green-600 text-white" : "bg-[#F27D26] text-white hover:bg-[#d96e1d]"
        )}
      >
        {isCopied ? <CheckCircle2 size={20} /> : <Copy size={20} />}
        {isCopied ? 'Đã sao chép!' : `Sao chép ${label}`}
      </button>
    );
  }

  return (
    <button
      onClick={handleCopy}
      className={cn(
        "p-2 rounded-lg transition-all border",
        isCopied ? "bg-green-50 border-green-200" : "bg-white border-gray-200 hover:bg-gray-50 hover:border-orange-200"
      )}
      title={`Sao chép ${label}`}
    >
      {isCopied ? <CheckCircle2 size={18} className="text-green-600" /> : <Copy size={18} className="text-[#F27D26]" />}
    </button>
  );
}

function NewspaperLayoutContent() {
  const [isClient, setIsClient] = useState(false);
  const pdfjsRef = useRef<any>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [currentFileIndex, setCurrentFileIndex] = useState<number>(-1);
  const [pdf, setPdf] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [pageImage, setPageImage] = useState<string | null>(null);
  const [maskImage, setMaskImage] = useState<string | null>(null);
  const [articleRegions, setArticleRegions] = useState<ArticleRegion[]>([]);
  const [groupedBoxes, setGroupBoxedBoxes] = useState<Map<string, BoundingBox[]>>(new Map());
  const [selectedArticleRegion, setSelectedArticleRegion] = useState<ArticleRegion | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [boxes, setBoxes] = useState<BoundingBox[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedBox, setSelectedBox] = useState<BoundingBox | null>(null);
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [viewMode, setViewMode] = useState<'all' | 'boxes' | 'regions' | 'articles' | 'lines'>('all');
  const [filteredFile, setFilteredFile] = useState<File | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());
  
  const filteredArticles = useMemo(() => {
    if (!filteredFile) return articles;
    return articles.filter(a => a.fileName === filteredFile.name);
  }, [articles, filteredFile]);
  
  const [pageSize, setPageSize] = useState({ width: 600, height: 800 });
  const [processingTime, setProcessingTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isProcessing || isExtracting) {
      setElapsedTime(0);
      interval = setInterval(() => {
        setElapsedTime(prev => prev + 1);
      }, 1000);
    } else {
      clearInterval(interval!);
    }
    return () => clearInterval(interval);
  }, [isProcessing, isExtracting]);
  
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const articleDetailRef = useRef<HTMLDivElement>(null);
  const articleListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsClient(true);
    // Load pdfjs only on client
    const loadPdfJs = async () => {
      try {
        const pdfjsModule = await import('pdfjs-dist/build/pdf.min.mjs');
        const pdfjs = (pdfjsModule as any).default || pdfjsModule;
        
        if (pdfjs && typeof pdfjs === 'object') {
          pdfjsRef.current = pdfjs;
          
          if (pdfjs.GlobalWorkerOptions) {
            // Use the version from the package or fallback to 5.5.207
            const version = pdfjs.version || '5.5.207';
            pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${version}/build/pdf.worker.min.mjs`;
          }
        }
      } catch (error) {
        console.error("Error loading pdfjs:", error);
      }
    };
    loadPdfJs();
  }, []);

  useEffect(() => {
    if (selectedArticle && articleDetailRef.current) {
      articleDetailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedArticle]);

  if (!isClient) return null;

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = event.target.files;
    if (!uploadedFiles || uploadedFiles.length === 0) return;

    const newFiles = Array.from(uploadedFiles);
    setFiles(prev => [...prev, ...newFiles]);
    
    if (currentFileIndex === -1) {
      setCurrentFileIndex(0);
      await loadFile(newFiles[0], true);
    }
  };

  const loadFile = async (fileToLoad: File, clearArticles: boolean = true): Promise<{ pdfDoc: any, image: string | null } | null> => {
    const pdfjs = pdfjsRef.current;
    if (!fileToLoad || !pdfjs) return null;

    setIsProcessing(true);
    setBoxes([]);
    setRegions([]);
    setSelectedBox(null);
    if (clearArticles) {
      setArticles([]);
    }
    setPageImage(null);
    setMaskImage(null);

    try {
      if (fileToLoad.type === 'application/pdf') {
        const arrayBuffer = await fileToLoad.arrayBuffer();
        const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
        const pdfDoc = await loadingTask.promise;
        setPdf(pdfDoc);
        setNumPages(pdfDoc.numPages);
        setCurrentPage(1);
        const image = await renderPage(pdfDoc, 1);
        return { pdfDoc, image };
      } else {
        const result = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(fileToLoad);
        });
        setPageImage(result);
        setIsProcessing(false);
        return { pdfDoc: null, image: result };
      }
    } catch (error) {
      console.error("Error loading file:", error);
      setIsProcessing(false);
      return null;
    }
  };

  const renderPage = async (pdfDoc: any, pageNum: number): Promise<string | null> => {
    try {
      setMaskImage(null); // Clear mask when switching pages
      setBoxes([]); // Clear boxes
      setArticleRegions([]); // Clear regions
      setSelectedArticleRegion(null);
      setSelectedBox(null);
      
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });
      setPageSize({ width: viewport.width, height: viewport.height });

      const scale = 3.0; 
      const renderViewport = page.getViewport({ scale });
      
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.height = renderViewport.height;
      canvas.width = renderViewport.width;

      if (context) {
        await page.render({ canvasContext: context, viewport: renderViewport }).promise;
        const image = canvas.toDataURL('image/png');
        setPageImage(image);
        return image;
      }
    } catch (error) {
      console.error("Error rendering page:", error);
    } finally {
      setIsProcessing(false);
    }
    return null;
  };

  const handleParseLayout = async () => {
    if (!pdf || !pageImage) return;
    setIsProcessing(true);
    
    try {
      const page = await pdf.getPage(currentPage);
      const result = await parseNewspaperLayout(page, pageImage);
      setBoxes(result.boxes);
      setMaskImage(result.maskImage || null);
      setArticleRegions(result.cells || []);
      
      if (result.cells) {
        const grouped = groupBoxesByArticleRegion(result.boxes, result.cells);
        setGroupBoxedBoxes(grouped);
      }
      
      setViewMode('boxes');
    } catch (error) {
      console.error("Error parsing layout:", error);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSegmentRegions = () => {
    if (boxes.length === 0) return;
    const segmented = segmentRegions(boxes);
    setRegions(segmented);
    setViewMode('regions');
  };

  const toggleFileSelection = (index: number) => {
    const newSelection = new Set(selectedFiles);
    if (newSelection.has(index)) {
      newSelection.delete(index);
    } else {
      newSelection.add(index);
    }
    setSelectedFiles(newSelection);
  };

  const handleExtractSelected = async () => {
    if (selectedFiles.size === 0) return;
    
    setArticles([]);
    setProcessingTime(null);
    const startTime = Date.now();
    let allArticles: Article[] = [];
    
    const indices = Array.from(selectedFiles);
    for (const index of indices) {
      setCurrentFileIndex(index);
      const result = await loadFile(files[index], false);
      if (result) {
        const extracted = await handleExtractArticles(result.pdfDoc, result.image || '', 1, files[index].name);
        allArticles = [...allArticles, ...extracted];
      }
    }
    const merged = mergeArticles(allArticles);
    setArticles(merged);
    setProcessingTime((Date.now() - startTime) / 1000);
  };

  const handleExtractAll = async () => {
    setArticles([]);
    setProcessingTime(null);
    const startTime = Date.now();
    let allArticles: Article[] = [];
    for (let i = 0; i < files.length; i++) {
      setCurrentFileIndex(i);
      const result = await loadFile(files[i], false);
      if (result) {
        const extracted = await handleExtractArticles(result.pdfDoc, result.image || '', 1, files[i].name);
        allArticles = [...allArticles, ...extracted];
      }
    }
    const merged = mergeArticles(allArticles);
    setArticles(merged);
    setProcessingTime((Date.now() - startTime) / 1000);
  };

  const handleExtractArticles = async (pdfDoc: any, image: string, pageNum: number, fileName: string): Promise<Article[]> => {
    if (!pdfDoc || !image) return [];

    setIsProcessing(true);
    const startTime = Date.now();
    try {
      const page = await pdfDoc.getPage(pageNum);
      
      // Tạo một bản render độ phân giải thấp (scale 1.0) dành riêng cho OpenCV
      // Điều này giúp OpenCV xử lý nhanh hơn gấp nhiều lần so với scale 3.0
      const viewport = page.getViewport({ scale: 1.0 });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      
      let analysisImage = image; // Fallback
      if (context) {
        await page.render({ canvasContext: context, viewport }).promise;
        analysisImage = canvas.toDataURL('image/png');
      }

      // Chạy song song các tác vụ
      const [layoutResult, textBlocks] = await Promise.all([
        parseNewspaperLayout(page, analysisImage),
        extractTextBlocksWithMetadata(page)
      ]);
      
      setBoxes(layoutResult.boxes);
      setMaskImage(layoutResult.maskImage || null);
      setArticleRegions(layoutResult.cells || []);
      
      if (layoutResult.cells) {
        const grouped = groupBoxesByArticleRegion(layoutResult.boxes, layoutResult.cells);
        setGroupBoxedBoxes(grouped);
      }
      
      const regions = segmentRegions(layoutResult.boxes);
      setRegions(regions);
      
      // Crop each ArticleRegion
      const croppedImages: string[] = [];
      const scaleFactor = 0.6; // Giảm độ phân giải xuống 60% để tối ưu dung lượng
      
      if (layoutResult.cells && layoutResult.cells.length > 0) {
        const img = new Image();
        img.src = analysisImage;
        await new Promise((resolve) => {
          img.onload = resolve;
        });

        for (const cell of layoutResult.cells) {
          const cropCanvas = document.createElement('canvas');
          cropCanvas.width = cell.bbox.width * scaleFactor;
          cropCanvas.height = cell.bbox.height * scaleFactor;
          const cropCtx = cropCanvas.getContext('2d');
          if (cropCtx) {
            // Fill background with white before drawing (for JPEG)
            cropCtx.fillStyle = '#FFFFFF';
            cropCtx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
            
            cropCtx.drawImage(
              img,
              cell.bbox.x,
              cell.bbox.y,
              cell.bbox.width,
              cell.bbox.height,
              0,
              0,
              cropCanvas.width,
              cropCanvas.height
            );
            // Sử dụng JPEG với chất lượng 0.7 để giảm dung lượng file
            croppedImages.push(cropCanvas.toDataURL('image/jpeg', 0.7));
          }
        }
      } else {
        // Fallback to full image if no regions found
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = canvas.width * scaleFactor;
        cropCanvas.height = canvas.height * scaleFactor;
        const cropCtx = cropCanvas.getContext('2d');
        if (cropCtx) {
          cropCtx.fillStyle = '#FFFFFF';
          cropCtx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
          cropCtx.drawImage(canvas, 0, 0, cropCanvas.width, cropCanvas.height);
          croppedImages.push(cropCanvas.toDataURL('image/jpeg', 0.7));
        } else {
          croppedImages.push(analysisImage);
        }
      }

      // Call Gemini
      const extractedArticles = await extractArticlesMultimodal(croppedImages, textBlocks, pageNum, fileName);
      
      setIsExtracting(false);
      setViewMode('articles');
      setProcessingTime((Date.now() - startTime) / 1000);
      return extractedArticles;
    } catch (error) {
      console.error("Error extracting articles:", error);
      return [];
    } finally {
      setIsProcessing(false);
    }
  };

  const getLabelColor = (label: string) => {
    switch (label) {
      case 'Text Region': return 'stroke-yellow-400 fill-yellow-400/20 text-yellow-800';
      case 'Image Region': return 'stroke-[#F27D26] fill-[#F27D26]/20 text-[#F27D26]';
      case 'Headline': return 'stroke-blue-500 fill-blue-500/20 text-blue-800';
      case 'Sapo': return 'stroke-green-500 fill-green-500/20 text-green-800';
      case 'Caption': return 'stroke-purple-500 fill-purple-500/20 text-purple-800';
      case 'Author': return 'stroke-pink-500 fill-pink-500/20 text-pink-800';
      case 'Content': return 'stroke-teal-500 fill-teal-500/20 text-teal-800';
      case 'Header':
      case 'Footer': return 'stroke-gray-300 fill-gray-300/10 text-gray-400';
      case 'Horizontal Line': return 'stroke-blue-600 fill-blue-600/40 text-blue-800';
      case 'Vertical Line': return 'stroke-green-600 fill-green-600/40 text-green-800';
      default: return 'stroke-gray-400 fill-gray-400/20 text-gray-800';
    }
  };

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#1A1A1A] font-sans">
      <header className="h-16 border-b border-gray-200 px-6 flex items-center justify-between bg-white sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-[#F27D26] rounded-lg flex items-center justify-center text-white">
            <Layout size={24} />
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          {(isProcessing || isExtracting) ? (
            <div className="flex items-center gap-2 text-sm text-gray-600 font-medium bg-gray-100 px-3 py-1.5 rounded-full">
              <span className="text-[#F27D26] animate-pulse">⏱</span>
              {formatTime(elapsedTime)}
            </div>
          ) : processingTime !== null && (
            <div className="flex items-center gap-2 text-sm text-gray-600 font-medium bg-gray-100 px-3 py-1.5 rounded-full">
              <span className="text-[#F27D26]">⏱</span>
              {formatTime(Math.floor(processingTime))}
            </div>
          )}
          <button 
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 bg-[#1A1A1A] text-white px-4 py-2 rounded-full hover:bg-black transition-colors text-sm font-medium"
          >
            <Upload size={18} />
            Upload Pages
          </button>
        </div>
        <input 
          type="file" 
          ref={fileInputRef} 
          onChange={handleFileUpload} 
          className="hidden" 
          accept=".pdf,image/*"
          multiple
        />
      </header>

      <main className="p-6 max-w-[1600px] mx-auto grid grid-cols-12 gap-6 h-[calc(100vh-80px)]">
        <div className="col-span-4 flex flex-col gap-4 h-full overflow-hidden">
          {files.length > 0 && (
            <div className="flex flex-col gap-2 max-h-40 overflow-y-auto pb-2">
              {files.map((f, index) => (
                <button
                  key={index}
                  onClick={() => toggleFileSelection(index)}
                  className={cn(
                    "px-3 py-2 rounded-lg text-xs font-medium border text-left flex items-center justify-between",
                    selectedFiles.has(index)
                      ? "bg-orange-50 border-orange-300 text-orange-900" 
                      : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
                  )}
                >
                  <span className="truncate">{f.name}</span>
                  {selectedFiles.has(index) && <CheckCircle2 size={14} className="text-orange-600" />}
                </button>
              ))}
            </div>
          )}
          <button 
            onClick={handleExtractSelected}
            disabled={selectedFiles.size === 0 || isProcessing}
            className="w-full py-3 rounded-xl flex items-center justify-center gap-2 transition-all text-sm font-bold shadow-sm bg-[#F27D26] text-white hover:bg-[#d96e1d] disabled:opacity-50"
          >
            <Layers size={16} />
            Trích xuất
          </button>
          <button 
            onClick={handleExtractAll}
            disabled={files.length === 0 || isProcessing}
            className="w-full py-3 rounded-xl flex items-center justify-center gap-2 transition-all text-sm font-bold shadow-sm bg-[#1A1A1A] text-white hover:bg-black disabled:opacity-50"
          >
            <Layers size={16} />
            Trích xuất tất cả
          </button>
          <div className="flex-1 bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col overflow-hidden">
            <div className="p-4 border-b border-gray-100">
              <h2 className="font-serif font-bold text-lg">Bài báo đã trích xuất</h2>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2" ref={articleListRef}>
              {filteredArticles.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {filteredArticles.map((article, idx) => (
                    <div 
                      key={idx} 
                      onClick={() => {
                        setSelectedArticle(article);
                        setTimeout(() => articleDetailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
                      }}
                      className={cn(
                        "p-2 rounded-lg border cursor-pointer transition-all",
                        selectedArticle === article ? "bg-orange-50 border-orange-200" : "bg-gray-50 border-gray-100 hover:border-orange-100"
                      )}
                    >
                      <h3 className="font-serif font-bold text-sm">{article.title}</h3>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center text-gray-400 gap-3 py-10">
                  <FileText size={40} className="opacity-20" />
                  <p className="text-sm text-center">Chưa có bài báo nào được trích xuất.</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="col-span-8 flex flex-col gap-6 h-full overflow-hidden">
          <div className="flex-1 overflow-y-auto p-6 bg-white rounded-2xl border border-gray-200 shadow-sm" ref={articleDetailRef}>
            {selectedArticle ? (
              <div className="space-y-6">
                <div className="flex items-center justify-between gap-4">
                  <h1 className="text-3xl font-serif font-bold leading-tight text-gray-900">{selectedArticle.title}</h1>
                  <CopyButton text={selectedArticle.title} label="Tiêu đề" />
                </div>
                {selectedArticle.author && (
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-sm font-bold text-gray-700">Tác giả: {selectedArticle.author}</p>
                    <CopyButton text={selectedArticle.author} label="Tác giả" />
                  </div>
                )}
                {selectedArticle.lead && (
                  <div className="flex items-start justify-between gap-4">
                    <div className="text-lg font-bold text-gray-800 italic">{selectedArticle.lead}</div>
                    <CopyButton text={selectedArticle.lead} label="Sapo" />
                  </div>
                )}
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-4">
                      {selectedArticle.content.map((para, i) => (
                        <p key={i} className="text-gray-800 leading-relaxed text-lg">{para}</p>
                      ))}
                    </div>
                    <CopyButton text={selectedArticle.content.join('\n\n')} label="Nội dung" />
                  </div>
                </div>
                {selectedArticle.imageCaption && (
                  <div className="flex items-start justify-between gap-4">
                    <div className="text-sm text-gray-600 italic">Chú thích ảnh: {selectedArticle.imageCaption}</div>
                    <CopyButton text={selectedArticle.imageCaption} label="Chú thích ảnh" />
                  </div>
                )}
                <div className="pt-4 border-t border-gray-200">
                  <CopyButton 
                    variant="square"
                    text={[
                      selectedArticle.title,
                      selectedArticle.author ? `Tác giả: ${selectedArticle.author}` : '',
                      selectedArticle.lead,
                      ...selectedArticle.content,
                      selectedArticle.imageCaption ? `Chú thích ảnh: ${selectedArticle.imageCaption}` : ''
                    ].filter(Boolean).join('\n\n')} 
                    label="toàn bộ bài báo" 
                  />
                </div>
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-3">
                <Layout size={40} className="opacity-20" />
                <p className="text-sm text-center">Chọn một bài báo từ danh sách bên trái<br/>để xem nội dung chi tiết</p>
              </div>
            )}
          </div>
          {/* <div className="h-1/3 bg-white rounded-2xl border border-gray-200 shadow-sm relative overflow-hidden flex items-center justify-center">
            {pageImage ? (
              <div className="relative w-full h-full p-4 flex items-center justify-center overflow-auto">
                <div className="relative inline-block shadow-2xl">
                  <NextImage 
                    src={pageImage} 
                    alt="Newspaper Page" 
                    width={600}
                    height={800}
                    unoptimized
                    className="max-w-full h-auto object-contain rounded-sm"
                  />
                </div>
                {numPages > 1 && (
                  <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-white/90 backdrop-blur shadow-lg rounded-full px-4 py-2 flex items-center gap-4 border border-gray-200">
                    <button 
                      disabled={currentPage === 1}
                      onClick={() => {
                        const next = currentPage - 1;
                        setCurrentPage(next);
                        renderPage(pdf, next);
                      }}
                      className="p-1 hover:bg-gray-100 rounded-full disabled:opacity-30"
                    >
                      <ChevronLeft size={20} />
                    </button>
                    <span className="text-sm font-medium">Trang {currentPage} / {numPages}</span>
                    <button 
                      disabled={currentPage === numPages}
                      onClick={() => {
                        const next = currentPage + 1;
                        setCurrentPage(next);
                        renderPage(pdf, next);
                      }}
                      className="p-1 hover:bg-gray-100 rounded-full disabled:opacity-30"
                    >
                      <ChevronRight size={20} />
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 text-gray-400">
                <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center border-2 border-dashed border-gray-200">
                  <FileText size={32} />
                </div>
                <p className="text-sm">Tải lên file PDF hoặc ảnh để bắt đầu</p>
              </div>
            )}
            {isProcessing && (
              <div className="absolute inset-0 bg-white/60 backdrop-blur-[2px] flex flex-col items-center justify-center z-10">
                <Loader2 className="animate-spin text-[#F27D26] mb-4" size={40} />
                <p className="text-sm font-medium text-gray-600">Đang xử lý dữ liệu...</p>
              </div>
            )}
          </div> */}
        </div>
      </main>
    </div>
  );
}

export default function NewspaperLayoutApp() {
  return (
    <ErrorBoundary>
      <NewspaperLayoutContent />
    </ErrorBoundary>
  );
}
