'use client';

import React, { useState } from 'react';
import { Upload, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

export default function PdfProcessor() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'processing' | 'completed' | 'failed'>('idle');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setStatus('idle');
      setError(null);
    }
  };

  const startProcessing = async () => {
    if (!file) return;

    setStatus('uploading');
    setError(null);

    try {
      // 1. Upload
      const uploadRes = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileUrl: file.name, userId: 'user123' }), // Simplified
      });
      const uploadData = await uploadRes.json();
      if (!uploadRes.ok) throw new Error(uploadData.error || 'Upload failed');
      
      setTaskId(uploadData.taskId);
      setStatus('processing');

      // 2. Process
      const processRes = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: uploadData.taskId }),
      });
      if (!processRes.ok) throw new Error('Processing failed');

      // 3. Poll Status
      pollStatus(uploadData.taskId);

    } catch (err: any) {
      setError(err.message);
      setStatus('failed');
    }
  };

  const pollStatus = async (id: string) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/status/${id}`);
        const data = await res.json();
        
        if (data.status === 'completed') {
          clearInterval(interval);
          setStatus('completed');
        } else if (data.status === 'failed') {
          clearInterval(interval);
          setStatus('failed');
          setError('Processing failed on server');
        }
      } catch (err) {
        clearInterval(interval);
        setStatus('failed');
        setError('Polling failed');
      }
    }, 2000);
  };

  return (
    <div className="p-6 bg-white rounded-2xl border border-gray-200 shadow-sm">
      <h2 className="text-lg font-bold mb-4">PDF Processor (Async)</h2>
      <input type="file" onChange={handleFileChange} className="mb-4" />
      <button 
        onClick={startProcessing}
        disabled={!file || status === 'uploading' || status === 'processing'}
        className="flex items-center gap-2 bg-[#F27D26] text-white px-4 py-2 rounded-full hover:bg-[#d96e1d] disabled:bg-gray-400"
      >
        {status === 'uploading' || status === 'processing' ? <Loader2 className="animate-spin" /> : <Upload />}
        {status === 'idle' ? 'Upload & Process' : status === 'uploading' ? 'Uploading...' : 'Processing...'}
      </button>

      {status === 'completed' && <div className="mt-4 text-green-600 flex items-center gap-2"><CheckCircle2 /> Completed!</div>}
      {status === 'failed' && <div className="mt-4 text-red-600 flex items-center gap-2"><AlertCircle /> {error}</div>}
    </div>
  );
}
