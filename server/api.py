from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import shutil
import os
import tempfile
from pipeline import NewspaperPipeline

app = FastAPI(title="Newspaper Extraction API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MODEL_PATH = '/content/drive/MyDrive/newspaper_model_best.pt'
API_KEY = os.environ.get("GEMINI_API_KEY")
pipeline = NewspaperPipeline(MODEL_PATH, API_KEY)

@app.post("/process-pdf")
async def process_pdf(file: UploadFile = File(...)):
    temp_dir = tempfile.mkdtemp()
    temp_file_path = os.path.join(temp_dir, file.filename)
    
    try:
        with open(temp_file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        results = pipeline.process_pdf(temp_file_path)
        
        return {"status": "success", "data": results}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
        
    finally:
        shutil.rmtree(temp_dir)
