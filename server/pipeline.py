import cv2
import easyocr
import json
import re
import os
from ultralytics import YOLO
from google.genai import GoogleGenAI
from pdf2image import convert_from_path

class NewspaperPipeline:
    def __init__(self, model_path, api_key):
        self.model = YOLO(model_path)
        self.reader = easyocr.Reader(['vi'])
        self.ai = GoogleGenAI(api_key=api_key)

    def process_pdf(self, pdf_path):
        images = convert_from_path(pdf_path, dpi=300)
        all_articles = []
        incomplete_article = None
        
        for i, img in enumerate(images):
            img_path = f"temp_page_{i}.jpg"
            img.save(img_path, 'JPEG')
            articles_on_page = self.process_page(img_path)
            
            if incomplete_article:
                if incomplete_article.get('is_end') and articles_on_page and articles_on_page[0].get('is_start'):
                    articles_on_page[0]['text'] = incomplete_article['text'] + "\n" + articles_on_page[0]['text']
                    incomplete_article = None
            
            if articles_on_page and articles_on_page[-1].get('is_end'):
                incomplete_article = articles_on_page.pop()
                
            all_articles.extend(articles_on_page)
            os.remove(img_path)
        return all_articles

    def process_page(self, image_path):
        img = cv2.imread(image_path)
        h, w, _ = img.shape
        detections = self._detect_layout(image_path)
        articles = self._group_and_stitch(detections, w, h)
        
        for article in articles:
            headline_text = self._extract_text_from_element(article['headline'], img)
            content_text = self._extract_and_clean(article, img)
            
            # Check if headline is sub-heading
            if len(headline_text) > 0 and len(headline_text) < 50 and headline_text.isupper():
                # Move to content
                article['text'] = headline_text + "\n" + content_text
                article['headline'] = {"class": "unknown", "bbox": [0,0,0,0], "text": "Không tiêu đề"}
            else:
                article['headline']['text'] = headline_text
                article['text'] = content_text
            
        return self._verify_with_gemini(articles)

    def _extract_text_from_element(self, element, img):
        x1, y1, x2, y2 = map(int, element['bbox'])
        crop = img[max(0, y1):y2, max(0, x1):x2]
        text_results = self.reader.readtext(crop, detail=0)
        return " ".join(text_results)

    def _detect_layout(self, image_path):
        results = self.model.predict(image_path, conf=0.5, verbose=False)
        detections = []
        for r in results:
            for box in r.boxes:
                detections.append({
                    "class": self.model.names[int(box.cls[0])],
                    "bbox": box.xyxy[0].tolist()
                })
        return detections

    def _group_and_stitch(self, detections, img_w, img_h):
        x_threshold = img_w * 0.05
        noise_classes = ['ad_box', 'header', 'footer']
        elements = [d for d in detections if d['class'] not in noise_classes]
        
        for el in elements:
            x1, y1, x2, y2 = el['bbox']
            el['x_center'] = (x1 + x2) / 2
            el['y_center'] = (y1 + y2) / 2

        elements.sort(key=lambda x: x['x_center'])
        
        columns = []
        if elements:
            current_col = [elements[0]]
            for el in elements[1:]:
                if abs(el['x_center'] - current_col[0]['x_center']) < x_threshold:
                    current_col.append(el)
                else:
                    columns.append(current_col)
                    current_col = [el]
            columns.append(current_col)
        
        articles = []
        for col in columns:
            col.sort(key=lambda x: x['y_center'])
            current_article = None
            for el in col:
                if el['class'] == 'headline':
                    current_article = {"headline": el, "content": []}
                    articles.append(current_article)
                elif current_article:
                    current_article["content"].append(el)
                else:
                    current_article = {"headline": {"class": "unknown", "bbox": [0,0,0,0]}, "content": [el]}
                    articles.append(current_article)
        
        for article in articles:
            if article['content']:
                last_el = article['content'][-1]
                if last_el['bbox'][3] > (img_h * 0.95):
                    article['is_continued'] = True
                else:
                    article['is_continued'] = False
        return articles

    def _extract_and_clean(self, article, img):
        full_text = ""
        for item in article['content']:
            x1, y1, x2, y2 = map(int, item['bbox'])
            crop = img[max(0, y1):y2, max(0, x1):x2]
            text_results = self.reader.readtext(crop, detail=0)
            full_text += " ".join(text_results) + "\n"
        
        # Detect markers
        article['is_start'] = bool(re.search(r"\(\s*XEM TRANG", full_text, re.IGNORECASE))
        article['is_end'] = bool(re.search(r"\(\s*Tiếp theo trang", full_text, re.IGNORECASE))
            
        # Sub-headings: short, all-caps, separate paragraph
        lines = full_text.split('\n')
        new_content = []
        for line in lines:
            if len(line) > 0 and len(line) < 50 and line.isupper():
                new_content.append(line)
            else:
                new_content.append(line)
        full_text = "\n".join(new_content)
        
        patterns = [r"\(\s*Tiếp theo trang\s*\d+\s*\)", r"\(\s*Xem tiếp trang\s*\d+\s*\)", r"\(\s*XEM TRANG\s*\d+\s*\)", r"Ảnh:\s*.*"]
        for p in patterns:
            full_text = re.sub(p, "", full_text, flags=re.IGNORECASE)
        return full_text.strip()

    def _verify_with_gemini(self, articles):
        final_output = []
        for article in articles:
            prompt = f"Tiêu đề: {article['headline'].get('text', 'Không tiêu đề')}\nNội dung: {article['text']}\nHãy kiểm tra và trả về JSON: {{'headline': '...', 'content': '...', 'is_start': {article.get('is_start', False)}, 'is_end': {article.get('is_end', False)}, 'is_continued': {article.get('is_continued', False)}}}"
            try:
                response = self.ai.models.generateContent(
                    model="gemini-3-flash-preview",
                    contents=prompt,
                    config={"responseMimeType": "application/json"}
                )
                final_output.append(json.loads(response.text))
            except:
                final_output.append(article)
        return final_output

    def _is_match(self, article1, article2):
        return article1['headline'].get('text') == article2['headline'].get('text')
