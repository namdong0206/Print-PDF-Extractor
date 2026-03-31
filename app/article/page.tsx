'use client';

import React, { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Article } from '@/lib/geminiProcessor';
import { Layout, FileText, ChevronLeft, Copy, Check } from 'lucide-react';
import Link from 'next/link';

function ArticleContent() {
  const searchParams = useSearchParams();
  const [state, setState] = useState<{ article: Article | null, loading: boolean }>({
    article: null,
    loading: true
  });
  const [copied, setCopied] = useState(false);
  const [currentUrl, setCurrentUrl] = useState('');

  useEffect(() => {
    window.scrollTo(0, 0);
    setCurrentUrl(window.location.href);
  }, [state.article]);

  useEffect(() => {
    const id = searchParams.get('id');
    let found: Article | null = null;
    
    if (id) {
      const savedArticles = localStorage.getItem('extracted_articles');
      if (savedArticles) {
        try {
          const articles: Article[] = JSON.parse(savedArticles);
          found = articles.find(a => a.id === id || a.title === id) || null;
        } catch (e) {
          console.error("Error parsing saved articles", e);
        }
      }
    }
    
    // Use a small timeout to avoid synchronous state update in effect warning
    const timer = setTimeout(() => {
      setState({ article: found, loading: false });
    }, 0);
    
    return () => clearTimeout(timer);
  }, [searchParams]);

  const copyToClipboard = () => {
    if (typeof window !== 'undefined') {
      navigator.clipboard.writeText(window.location.href).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  const { article, loading } = state;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#FDFCFB]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[#F27D26]"></div>
      </div>
    );
  }

  if (!article) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#FDFCFB] p-6 text-center">
        <FileText size={64} className="text-gray-200 mb-4" />
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Không tìm thấy bài báo</h1>
        <p className="text-gray-500 mb-6">Bài báo bạn đang tìm kiếm không tồn tại hoặc đã bị xóa.</p>
        <Link href="/" className="bg-[#1A1A1A] text-white px-6 py-3 rounded-xl font-bold hover:bg-black transition-colors">
          Quay lại trang chủ
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#1A1A1A] font-sans pb-20">
      <header className="h-16 border-b border-gray-200 px-6 flex items-center justify-between bg-white sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <Link href="/" className="p-2 hover:bg-gray-100 rounded-full transition-colors">
            <ChevronLeft size={24} />
          </Link>
          <div className="w-8 h-8 bg-[#F27D26] rounded-lg flex items-center justify-center text-white">
            <Layout size={18} />
          </div>
          <span className="font-serif font-bold text-lg truncate max-w-[200px] md:max-w-md">
            {article.title}
          </span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto p-6 md:p-12 bg-white shadow-sm mt-8 rounded-2xl border border-gray-100">
        <article className="space-y-8">
          <div className="flex items-center justify-between gap-4 text-sm bg-gray-50 p-3 rounded-lg border border-gray-100">
            <span className="text-gray-600 truncate font-mono">{currentUrl}</span>
            <div className="flex items-center gap-4">
              <a href={`/api/article/raw/${article.id}`} target="_blank" rel="noopener noreferrer" className="text-[#F27D26] hover:text-[#d66d1f] font-bold">
                Xem trang riêng
              </a>
              <button onClick={copyToClipboard} className="flex items-center gap-1 text-[#F27D26] hover:text-[#d66d1f] font-bold">
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? 'Đã copy' : 'Copy'}
              </button>
            </div>
          </div>
          <h1 className="text-4xl md:text-5xl font-serif font-bold leading-tight text-gray-900">
            {article.title}
          </h1>

          <div className="flex flex-wrap items-center gap-4 text-sm text-gray-500 border-y border-gray-100 py-4">
            {article.author && (
              <span className="font-bold text-gray-900">Tác giả: {article.author}</span>
            )}
            <span className="flex items-center gap-1">
              <FileText size={14} />
              Trang: {article.pageNumbers.join(', ')}
            </span>
          </div>

          {article.lead && (
            <div className="text-xl md:text-2xl font-bold text-gray-800 italic leading-snug border-l-4 border-[#F27D26] pl-6 py-2">
              {article.lead}
            </div>
          )}

          <div className="space-y-6">
            {article.content.map((para, i) => (
              <p key={i} className="text-gray-800 leading-relaxed text-xl">
                {para}
              </p>
            ))}
          </div>

          {article.imageCaption && (
            <div className="bg-gray-50 p-4 rounded-xl text-sm text-gray-600 italic border-l-2 border-gray-200">
              Chú thích ảnh: {article.imageCaption}
            </div>
          )}
        </article>
      </main>

      <footer className="max-w-3xl mx-auto mt-12 px-6 text-center text-gray-400 text-sm">
        <p>© 2026 Hệ thống trích xuất báo in. Tất cả nội dung được trích xuất tự động.</p>
      </footer>
    </div>
  );
}

export default function ArticlePage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-[#FDFCFB]">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-[#F27D26]"></div>
      </div>
    }>
      <ArticleContent />
    </Suspense>
  );
}
