'use client';

import { doc, setDoc, collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db, auth } from '@/lib/firebase';
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
  Check,
  CheckCircle2,
  Copy,
  Loader2,
  AlertCircle,
  Box,
  ExternalLink,
  Download,
  FileDown
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseNewspaperLayout } from '@/lib/layoutService';
import { parseNewspaperLayoutHybrid } from '@/lib/hlaService';
import { ArticleRegion, BoundingBox } from '@/lib/types';
import { segmentRegions, Region, groupBoxesByArticleRegion } from '@/lib/segmentationService';
import { extractTextBlocksWithMetadata, extractArticlesHybrid, TextBlock, Article, mergeArticles, isSimilarTitle, QuotaExhaustedError } from '@/lib/geminiProcessor';
import { processArticleContent } from '@/lib/textProcessor';
import { HLAZone } from '@/lib/hlaService';
import { exportArticleToWord, exportAllArticlesToZip } from '@/lib/wordExport';
import * as Comlink from 'comlink';
import { getCache, setCache } from '@/lib/cacheService';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

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
  const [processingFileIndices, setProcessingFileIndices] = useState<Set<number>>(new Set());
  const [completedFileIndices, setCompletedFileIndices] = useState<Set<number>>(new Set());
  const [isExtracting, setIsExtracting] = useState(false);
  const [boxes, setBoxes] = useState<BoundingBox[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedBox, setSelectedBox] = useState<BoundingBox | null>(null);
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [viewMode, setViewMode] = useState<'all' | 'boxes' | 'regions' | 'articles' | 'lines'>('all');
  const [filteredFile, setFilteredFile] = useState<File | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());
  const [hlaZones, setHlaZones] = useState<HLAZone[]>([]);
  
  const filteredArticles = useMemo(() => {
    if (!filteredFile) return articles;
    return articles.filter(a => a.fileName === filteredFile.name);
  }, [articles, filteredFile]);
  
  const [pageSize, setPageSize] = useState({ width: 600, height: 800 });
  const [processingTime, setProcessingTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const playTingSound = () => {
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1200, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.5);
      
      gain.gain.setValueAtTime(1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch (e) {
      console.error("Audio play failed", e);
    }
  };
  
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
  const fileListRef = useRef<HTMLDivElement>(null);

  // Tự động cuộn danh sách file đến file đang được xử lý
  useEffect(() => {
    if (fileListRef.current && processingFileIndices.size > 0) {
      const firstProcessingIndex = Array.from(processingFileIndices)[0];
      const fileElement = fileListRef.current.children[firstProcessingIndex] as HTMLElement;
      if (fileElement) {
        fileElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [processingFileIndices]);

  useEffect(() => {
    setIsClient(true);
    
    // Load saved articles from localStorage
    const saved = localStorage.getItem('extracted_articles');
    if (saved) {
      try {
        setArticles(JSON.parse(saved));
      } catch (e) {
        console.error("Error parsing saved articles", e);
      }
    }

    // Load pdfjs only on client
    const loadPdfJs = async () => {
      try {
        const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
        
        if (pdfjs) {
          pdfjsRef.current = pdfjs;
          
          if (pdfjs.GlobalWorkerOptions) {
            // Use the version from the package
            const version = pdfjs.version || '5.6.205';
            pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${version}/legacy/build/pdf.worker.min.mjs`;
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
      articleDetailRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [selectedArticle]);

  // Tự động cuộn xuống cuối danh sách khi có bài báo mới được trích xuất hoặc cập nhật
  useEffect(() => {
    if (articleListRef.current && articles.length > 0 && isExtracting) {
      articleListRef.current.scrollTo({
        top: articleListRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [articles, isExtracting]);

  const clearOldArticles = async () => {
    try {
      const querySnapshot = await getDocs(collection(db, 'articles'));
      const deletePromises = querySnapshot.docs.map(document => 
        deleteDoc(doc(db, 'articles', document.id))
      );
      await Promise.all(deletePromises);
    } catch (error) {
      console.error("Error clearing old articles from Firestore:", error);
    }
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFiles = event.target.files;
    if (!uploadedFiles || uploadedFiles.length === 0) return;

    // Xóa toàn bộ dữ liệu phiên làm việc trước
    localStorage.removeItem('extracted_articles');
    await clearOldArticles();
    
    const newFiles = Array.from(uploadedFiles);
    setFiles(newFiles);
    setCompletedFileIndices(new Set());
    setCurrentFileIndex(0);
    setPdf(null);
    setNumPages(0);
    setCurrentPage(1);
    setPageImage(null);
    setMaskImage(null);
    setArticleRegions([]);
    setGroupBoxedBoxes(new Map());
    setSelectedArticleRegion(null);
    setProcessingFileIndices(new Set());
    setBoxes([]);
    setRegions([]);
    setArticles([]);
    setHlaZones([]);
    setViewMode('all');
    setSelectedArticle(null);
    setSelectedBox(null);
    setFilteredFile(null);
    setSelectedFiles(new Set());
    setProcessingTime(null);
    setElapsedTime(0);
    setPageSize({ width: 600, height: 800 });
    setIsProcessing(false);
    setIsExtracting(false);
    
    // Bắt đầu phiên làm việc mới với file đầu tiên
    await loadFile(newFiles[0], true);
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
        const loadingTask = pdfjs.getDocument({ 
          data: arrayBuffer,
          disableFontFace: true,
          disableRange: true
        });
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

      // Optimization: Downscale if image is too large
      const MAX_WIDTH = 1600;
      let scale = 2.0; // Default high quality
      if (viewport.width * scale > MAX_WIDTH) {
        scale = MAX_WIDTH / viewport.width;
      }
      
      const renderViewport = page.getViewport({ scale });
      
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.height = renderViewport.height;
      canvas.width = renderViewport.width;

      if (context) {
        await page.render({ canvasContext: context, viewport: renderViewport }).promise;
        // Optimization: Use WebP format and lower quality to reduce payload size
        const image = canvas.toDataURL('image/webp', 0.8);
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

  const workerRef = useRef<any>(null);

  useEffect(() => {
    // Khởi tạo Worker
    const worker = new Worker(new URL('@/lib/worker.ts', import.meta.url));
    workerRef.current = Comlink.wrap(worker);
    
    return () => worker.terminate();
  }, []);

  const handleParseLayout = async () => {
    if (!pdf || !pageImage) return;
    setIsProcessing(true);
    
    try {
      const page = await pdf.getPage(currentPage);
      
      // 1. Kiểm tra Cache
      const cacheKey = `${files[currentFileIndex].name}-${currentPage}`;
      const cached = await getCache('layoutCache', cacheKey);
      
      let result;
      if (cached) {
        result = cached;
      } else {
        // 2. Gọi Worker xử lý layout
        result = await workerRef.current.processLayout(page);
        await setCache('layoutCache', cacheKey, result);
      }

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

  const processInParallel = async (indices: number[], concurrency: number = 2) => {
    const results: Article[] = [];
    let currentIndex = 0;
    let quotaError: any = null;
    
    const handleArticleParsed = (article: Article) => {
      setArticles(prev => {
        const merged = mergeArticles([...prev, article]);
        
        // Find the merged version of this article to save to Firestore
        const mergedArticle = merged.find(a => isSimilarTitle(a.title, article.title));
        if (mergedArticle) {
          setDoc(doc(db, 'articles', mergedArticle.id), mergedArticle).catch(e => console.error("Error saving article:", e));
        }
        
        return merged;
      });
    };

    const processNext = async (): Promise<void> => {
      if (currentIndex >= indices.length || quotaError) return;
      
      const index = indices[currentIndex++];
      setProcessingFileIndices(prev => new Set(prev).add(index));
      const file = files[index];
      
      // Render page for this specific file
      const pdfjs = pdfjsRef.current;
      if (!pdfjs) return;
      
      try {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
        const pdfDoc = await loadingTask.promise;
        // Always get page 1 of the current file
        const page = await pdfDoc.getPage(1);
        
        // Render to image for Gemini
        const viewport = page.getViewport({ scale: 1.0 });
        const MAX_WIDTH = 1600;
        let scale = 2.0;
        if (viewport.width * scale > MAX_WIDTH) {
          scale = MAX_WIDTH / viewport.width;
        }
        const renderViewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = renderViewport.height;
        canvas.width = renderViewport.width;
        
        if (context) {
          await page.render({ canvasContext: context, viewport: renderViewport }).promise;
          const image = canvas.toDataURL('image/webp', 0.8);
          // Pass 1 as the document page number, but index + 1 as the metadata page number
          const fileArticles = await handleExtractArticles(pdfDoc, image, 1, file.name, handleArticleParsed, index + 1);
          results.push(...fileArticles);
        }
      } catch (error: any) {
        console.error(`Error processing file ${file.name}:`, error);
        if (error instanceof QuotaExhaustedError || error?.message?.includes('Thành thật xin lỗi')) {
          quotaError = error;
          if (error.partialArticles) {
            results.push(...error.partialArticles);
          }
        }
      } finally {
        setProcessingFileIndices(prev => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
        setCompletedFileIndices(prev => new Set(prev).add(index));
        if (!quotaError) {
          await processNext();
        }
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, indices.length); i++) {
      workers.push(processNext());
    }
    
    await Promise.all(workers);
    if (quotaError) {
      quotaError.partialArticles = results; // Attach all results gathered so far
      throw quotaError;
    }
    return results;
  };

  const handleExtractSelected = async () => {
    if (selectedFiles.size === 0) return;
    
    setArticles([]);
    setCompletedFileIndices(new Set());
    setProcessingTime(null);
    setIsProcessing(true);
    setIsExtracting(true);
    const startTime = Date.now();
    
    try {
      const indices = Array.from(selectedFiles).sort((a, b) => 
        files[a].name.localeCompare(files[b].name, undefined, { numeric: true, sensitivity: 'base' })
      );

      const allArticles = await processInParallel(indices);
      const merged = mergeArticles(allArticles);
      setArticles(merged);
      localStorage.setItem('extracted_articles', JSON.stringify(merged));
      
      setViewMode('articles');
      setProcessingTime((Date.now() - startTime) / 1000);
      playTingSound();
      setToastMessage("Toàn bộ nội dung đã được trích xuất xong");
      setTimeout(() => setToastMessage(null), 3000);
    } catch (error: any) {
      if (error instanceof QuotaExhaustedError || error?.message?.includes('Thành thật xin lỗi')) {
        // Vẫn hiển thị những bài báo đã trích xuất được
        const partialArticles = error.partialArticles || [];
        if (partialArticles.length > 0) {
          const merged = mergeArticles(partialArticles);
          setArticles(merged);
          localStorage.setItem('extracted_articles', JSON.stringify(merged));
          setViewMode('articles');
        }
        alert(error.message);
      } else {
        console.error("Lỗi trong quá trình trích xuất:", error);
      }
    } finally {
      setIsProcessing(false);
      setIsExtracting(false);
    }
  };

  const handleExtractAll = async () => {
    setArticles([]);
    setCompletedFileIndices(new Set());
    setProcessingTime(null);
    setIsProcessing(true);
    setIsExtracting(true);
    const startTime = Date.now();
    
    try {
      const sortedIndices = Array.from({ length: files.length }, (_, i) => i).sort((a, b) => 
        files[a].name.localeCompare(files[b].name, undefined, { numeric: true, sensitivity: 'base' })
      );

      const allArticles = await processInParallel(sortedIndices);
      const merged = mergeArticles(allArticles);
      setArticles(merged);
      localStorage.setItem('extracted_articles', JSON.stringify(merged));
      
      setViewMode('articles');
      setProcessingTime((Date.now() - startTime) / 1000);
      playTingSound();
      setToastMessage("Toàn bộ nội dung đã được trích xuất xong");
      setTimeout(() => setToastMessage(null), 3000);
    } catch (error: any) {
      if (error instanceof QuotaExhaustedError || error?.message?.includes('Thành thật xin lỗi')) {
        // Vẫn hiển thị những bài báo đã trích xuất được
        const partialArticles = error.partialArticles || [];
        if (partialArticles.length > 0) {
          const merged = mergeArticles(partialArticles);
          setArticles(merged);
          localStorage.setItem('extracted_articles', JSON.stringify(merged));
          setViewMode('articles');
        }
        alert(error.message);
      } else {
        console.error("Lỗi trong quá trình trích xuất:", error);
      }
    } finally {
      setIsProcessing(false);
      setIsExtracting(false);
    }
  };

  const handleExtractArticles = async (
    pdfDoc: any, 
    image: string, 
    docPageNum: number, 
    fileName: string, 
    onArticleParsed?: (article: Article) => void,
    metadataPageNum?: number
  ): Promise<Article[]> => {
    if (!pdfDoc) return [];

    try {
      const page = await pdfDoc.getPage(docPageNum);
      
      // 1. Hybrid Layout Analysis (Heuristic)
      console.time("HLATime");
      const { zones } = await parseNewspaperLayoutHybrid(page);
      console.timeEnd("HLATime");
      
      setHlaZones(zones);
      
      // 2. Semantic Extraction (Gemini 3 Flash - Multimodal)
      // Use metadataPageNum if provided, otherwise docPageNum
      const finalPageNum = metadataPageNum ?? docPageNum;
      const extractedArticles = await extractArticlesHybrid(zones, finalPageNum, fileName, image, onArticleParsed);
      
      return extractedArticles;
    } catch (error: any) {
      console.error("Error extracting articles:", error);
      if (error instanceof QuotaExhaustedError || error?.message?.includes('Thành thật xin lỗi')) {
        throw error;
      }
      return [];
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

  if (!isClient) return <div className="min-h-screen bg-[#FDFCFB]" />;

  if (!isClient) return <div className="min-h-screen bg-[#FDFCFB]" />;

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#1A1A1A] font-sans">
      {toastMessage && (
        <div className="fixed top-20 left-1/2 transform -translate-x-1/2 z-50 bg-green-600 text-white px-6 py-3 rounded-full shadow-lg font-bold flex items-center gap-2 animate-in fade-in slide-in-from-top-4">
          <CheckCircle2 size={20} />
          {toastMessage}
        </div>
      )}
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
            <div className="flex flex-col gap-2 max-h-40 overflow-y-auto pb-2" ref={fileListRef}>
              {files.map((f, index) => (
                <button
                  key={index}
                  onClick={() => toggleFileSelection(index)}
                  className={cn(
                    "px-3 py-2 rounded-lg text-xs font-medium border text-left flex items-center justify-between transition-colors",
                    processingFileIndices.has(index) 
                      ? "bg-orange-100 border-[#F27D26] text-[#F27D26]"
                      : selectedFiles.has(index)
                        ? "bg-orange-50 border-orange-300 text-orange-900" 
                        : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
                  )}
                >
                  <div className="flex flex-col truncate">
                    <div className="flex items-center gap-1 truncate">
                      <span className="truncate">{f.name}</span>
                      {completedFileIndices.has(index) && (
                        <Check size={12} className="text-green-600 flex-shrink-0" />
                      )}
                    </div>
                    {processingFileIndices.has(index) && (
                      <span className="text-[10px] font-bold animate-pulse">Đang xử lý...</span>
                    )}
                  </div>
                  {processingFileIndices.has(index) ? (
                    <Loader2 size={14} className="animate-spin text-[#F27D26]" />
                  ) : selectedFiles.has(index) ? (
                    <CheckCircle2 size={14} className="text-orange-600" />
                  ) : null}
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
            <div className="p-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-serif font-bold text-lg">Bài báo đã trích xuất</h2>
              {filteredArticles.length > 0 && (
                <button
                  onClick={() => exportAllArticlesToZip(filteredArticles)}
                  className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 text-[#F27D26] transition-all flex items-center gap-2 text-sm font-bold"
                  title="Xuất tất cả ra file nén (.zip)"
                >
                  <Download size={18} />
                  <span className="hidden md:inline">Xuất tất cả</span>
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2" ref={articleListRef}>
              {filteredArticles.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {filteredArticles.map((article, idx) => (
                    <div 
                      key={idx} 
                      onClick={() => {
                        setSelectedArticle(article);
                        setTimeout(() => articleDetailRef.current?.scrollTo({ top: 0, behavior: 'smooth' }), 100);
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
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => exportArticleToWord(selectedArticle)}
                      className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 text-[#F27D26] transition-all flex items-center gap-2 text-sm font-bold"
                      title="Xuất file Word (.docx)"
                    >
                      <FileDown size={18} />
                      <span className="hidden md:inline">Xuất file Word</span>
                    </button>
                    <a 
                      href={`/api/article/raw/${selectedArticle.id}`} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50 text-[#F27D26] transition-all flex items-center gap-2 text-sm font-bold"
                      title="Mở trang riêng"
                    >
                      <ExternalLink size={18} />
                      <span className="hidden md:inline">Xem trang riêng</span>
                    </a>
                    <CopyButton text={selectedArticle.title} label="Tiêu đề" />
                  </div>
                </div>
                {selectedArticle.author && selectedArticle.author !== 'null' && (
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-sm font-bold text-gray-700">Tác giả: {selectedArticle.author}</p>
                    <CopyButton text={selectedArticle.author} label="Tác giả" />
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
                {selectedArticle.imageCaption && selectedArticle.imageCaption !== 'null' && (
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
                      selectedArticle.author && selectedArticle.author !== 'null' ? `Tác giả: ${selectedArticle.author}` : '',
                      ...selectedArticle.content,
                      selectedArticle.imageCaption && selectedArticle.imageCaption !== 'null' ? `Chú thích ảnh: ${selectedArticle.imageCaption}` : ''
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
