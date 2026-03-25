import os
import requests
import tempfile
import time
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from supabase import create_client, Client
from google import genai 
import json
import re
FRONTEND_FOLDER = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'frontend'))

app = Flask(__name__, static_folder=FRONTEND_FOLDER)
CORS(app)

# --- CONFIGURATION ---
SUPABASE_URL = "https://gjjgrzqjyqnphkrntspf.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdqamdyenFqeXFucGhrcm50c3BmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNDU1MDksImV4cCI6MjA4OTkyMTUwOX0.sDysEzrCl5YSvCzFbkFrOhunOA5jmpGeyejm0xnIm9A"
GEMINI_API_KEY = "AIzaSyAMmxrWngDwKitFgdA-5VMuPzmnMg07Sjg"

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
client = genai.Client(api_key=GEMINI_API_KEY)

# --- SHARED CACHE ---
gemini_file_cache = {}

# ==========================================
# 1. CORE AI ENGINES
# ==========================================
@app.route('/')
def serve_index():
    """Serves your index.html file when someone visits the root URL"""
    return send_from_directory(app.static_folder, 'index.html')
@app.route('/<path:path>')
def serve_static_files(path):
    """Serves all your JS files, images (like logo.jpeg), and CSS"""
    return send_from_directory(app.static_folder, path)
def get_or_upload_gemini_file(lesson_name):
    """(Used only once per chapter) Uploads the raw PDF to Gemini."""
    if lesson_name in gemini_file_cache:
        print(f"⚡ CACHE HIT for {lesson_name}")
        return client.files.get(name=gemini_file_cache[lesson_name])
    
    print(f"⏳ CACHE MISS for {lesson_name}. Fetching PDF from Supabase...")
    res = supabase.table('lesson_files').select('file_path').eq('ui_lesson_name', lesson_name).execute()
    if not res.data:
        raise Exception("Lesson not found in database")
    
    file_path = res.data[0]['file_path']
    public_url = supabase.storage.from_('syllabus_pdfs').get_public_url(file_path)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        pdf_res = requests.get(public_url)
        tmp.write(pdf_res.content)
        temp_path = tmp.name

    print("☁️ Uploading PDF to Gemini for initial extraction...")
    uploaded_file = client.files.upload(file=temp_path)
    
    while uploaded_file.state == "PROCESSING":
        time.sleep(2)
        uploaded_file = client.files.get(name=uploaded_file.name)
        
    if uploaded_file.state == "FAILED":
        raise Exception("Google AI failed to process the PDF.")
        
    gemini_file_cache[lesson_name] = uploaded_file.name
    os.remove(temp_path)
    return uploaded_file

def generate_with_fallback_file(prompt_text, uploaded_file):
    """Heavy generation used ONLY for the initial PDF-to-Text extraction."""
    # FIX: Using official production model names
    stable_models = [
        "gemini-2.5-flash",
        "gemini-2.0-flash", 
        "gemini-1.5-flash",        
        "gemini-1.5-pro"         
    ]
    for model_name in stable_models:
        try:
            print(f"🤖 Extracting File with {model_name}...")
            return client.models.generate_content(
                model=model_name, 
                contents=[uploaded_file, prompt_text]
            ).text
        except Exception as e:
            print(f"⚠️ {model_name} failed on file extraction: {str(e)}") 
            time.sleep(1)
            
    raise Exception("Critical: All API quotas are fully depleted.")

def generate_text_only(prompt_text):
    """BLAZING FAST generation. Used for 99% of app queries using pure cached text."""
    # FIX: Using official production model names
    stable_models = [
        "gemini-2.5-flash",
        "gemini-2.0-flash", 
        "gemini-1.5-flash",        
        "gemini-1.5-pro"         
    ]
    for model_name in stable_models:
        try:
            print(f"⚡ Generating purely from text using {model_name}...")
            return client.models.generate_content(
                model=model_name, 
                contents=[prompt_text]
            ).text
        except Exception as e:
            print(f"⚠️ {model_name} failed on text generation: {str(e)}") 
            time.sleep(1)
            
    raise Exception("Critical: All API quotas are fully depleted.")
# ==========================================
# 2. THE AUTOMATED ETL PIPELINE
# ==========================================

def get_or_extract_lesson_text(lesson_name):
    """The Gatekeeper: Gets fast text from DB, or forces Gemini to extract it if missing."""
    print(f"🔍 Checking DB for clean text: {lesson_name}")
    db_check = supabase.table('lesson_text_cache').select('extracted_text').eq('lesson_name', lesson_name).execute()
    
    if db_check.data:
        print("⚡ TEXT CACHE HIT! Bypassing PDF upload.")
        return db_check.data[0]['extracted_text']

    print("⏳ TEXT CACHE MISS. Commanding Gemini to extract PDF with LaTeX...")
    uploaded_file = get_or_upload_gemini_file(lesson_name)
    
    extraction_prompt = """
    Extract all the educational content from this textbook chapter. 
    CRITICAL INSTRUCTIONS:
    1. Preserve all mathematical formulas, equations, and Greek symbols perfectly.
    2. Format all math using strict LaTeX. Use single $ for inline math and double $$ for block equations.
    3. Keep the output clean, using standard Markdown.
    4. Do not summarize. Give me the comprehensive text.
    """
    
    extracted_text = generate_with_fallback_file(extraction_prompt, uploaded_file)
    
    print("💾 Saving extracted LaTeX Markdown to Supabase permanently...")
    supabase.table('lesson_text_cache').insert({
        "lesson_name": lesson_name,
        "extracted_text": extracted_text
    }).execute()
    
    return extracted_text


# ==========================================
# 3. API ROUTES
# ==========================================

# --- ROUTE 1: GET CONCEPTS ---
@app.route('/get-concepts', methods=['POST'])
def get_concepts():
    try:
        lesson_name = request.json.get('ui_lesson_name')
        
        # 1. Check Concepts Cache FIRST
        print(f"🔍 Checking Supabase for existing concepts: {lesson_name}")
        db_check = supabase.table('lesson_concepts').select('concepts_list').eq('lesson_name', lesson_name).execute()
        
        if db_check.data:
            print(f"⚡ DATABASE HIT! Instantly loading concepts for {lesson_name}")
            return jsonify({"concepts": db_check.data[0]['concepts_list']})

        # 2. Get the clean text (Triggers PDF ETL if first time)
        print(f"⏳ DATABASE MISS. Asking AI to generate concepts...")
        lesson_text = get_or_extract_lesson_text(lesson_name)
        
        prompt = f"""
        Read the following textbook chapter:
        {lesson_text}
        
        Identify the 5 most important core concepts in this text. Return ONLY the concept names separated by the pipe character '|'. Example: Concept A | Concept B | Concept C
        """
        result = generate_text_only(prompt)
        
        concepts = [c.strip() for c in result.split('|') if c.strip()]
        
        print(f"💾 Saving new concepts to Supabase database...")
        supabase.table('lesson_concepts').insert({
            "lesson_name": lesson_name,
            "concepts_list": concepts
        }).execute()
        
        return jsonify({"concepts": concepts})
        
    except Exception as e:
        print(f"ERROR in get_concepts: {str(e)}")
        return jsonify({"error": str(e)}), 500
    
# --- ROUTE 2: GENERATE QUESTIONS ---
@app.route('/generate-questions', methods=['POST'])
def generate_questions():
    try:
        lesson_name = request.json.get('ui_lesson_name')
        concept = request.json.get('concept')
        
        lesson_text = get_or_extract_lesson_text(lesson_name)
        
        prompt = f"""
        Source Chapter Text:
        {lesson_text}
        
        Based strictly on the text above, generate 3 challenging, contradictory, or analytical questions about the concept '{concept}' to test a student's deep understanding. Format it as a numbered list. Use LaTeX ($) for math.
        """
        questions = generate_text_only(prompt)
        
        return jsonify({"questions": questions})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- ROUTE 3: EVALUATE & CHAT ---
@app.route('/evaluate-concept', methods=['POST'])
def evaluate_concept():
    try:
        data = request.json
        lesson_name = data.get('ui_lesson_name')
        concept = data.get('concept')
        student_answer = data.get('studentAnswer')
        ai_questions = data.get('aiQuestions')
        chat_history = data.get('chatHistory', "") 
        
        lesson_text = get_or_extract_lesson_text(lesson_name)
        
        if not chat_history:
            prompt = f"""
            Source Chapter Text:
            {lesson_text}

            You are a highly encouraging TN State Board tutor. The student was asked to defend their understanding of '{concept}' based on these questions:\n{ai_questions}\n\nHere is their initial answer: {student_answer}\n\nEvaluate their understanding based strictly on the text. If they are right, praise them. If there are inaccuracies, explain the concept practically using real-world examples. Use LaTeX ($) for math. End by asking if they have any doubts or need clarification."""
        else:
            prompt = f"""
            Source Chapter Text:
            {lesson_text}

            You are a TN State Board tutor explaining the concept '{concept}' using the text.\n\nHere is the conversation so far:\n{chat_history}\n\nStudent's new question/reply: {student_answer}\n\nAnswer their question clearly, practically, and conversationally. Use LaTeX ($) for math. Keep it highly relevant to the text."""

        evaluation = generate_text_only(prompt)
        
        return jsonify({"response": evaluation})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- ROUTE 4: GENERATE 1V1 MATCH QUESTIONS ---
@app.route('/generate-mcqs', methods=['POST'])
def generate_mcqs():
    try:
        data = request.json or {}
        lesson_name = data.get('ui_lesson_name')
        concept = data.get('concept')

        if not lesson_name or not concept:
            return jsonify({"error": "ui_lesson_name and concept are required"}), 400

        lesson_text = get_or_extract_lesson_text(lesson_name)

        prompt = f""" 
Source Chapter Text:
{lesson_text}

Based strictly on the text above, generate exactly 10 challenging multiple-choice questions about the concept '{concept}'.

Rules:
- Return ONLY a valid JSON array.
- Do NOT use markdown, code fences, explanations, or extra text outside the JSON array.
- Use LaTeX formatting ($ and $$) for any math inside the questions or options.
- Each object must have exactly these keys:
  - "question_text" (string)
  - "options" (array of exactly 4 strings)
  - "correct_option" (string, must exactly match one of the 4 options)

Example format:
[
  {{
    "question_text": "What is ...?",
    "options": ["A", "B", "C", "D"],
    "correct_option": "A"
  }}
]
"""

        result_text = generate_text_only(prompt)

        # Clean up common Gemini formatting issues
        cleaned = result_text.strip()
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned)

        # Extract the first JSON array from the response
        match = re.search(r"\[[\s\S]*\]", cleaned)
        if not match:
            raise ValueError(f"Model did not return a JSON array. Raw output: {result_text}")

        questions = json.loads(match.group(0))

        if not isinstance(questions, list):
            raise ValueError("Parsed output is not a list.")

        if len(questions) != 10:
            print(f"⚠️ Expected 10 questions, got {len(questions)}")

        # Light validation / normalization
        validated_questions = []
        for q in questions:
            if not isinstance(q, dict):
                continue

            question_text = str(q.get("question_text", "")).strip()
            options = q.get("options", [])
            correct_option = str(q.get("correct_option", "")).strip()

            if not question_text or not isinstance(options, list) or len(options) != 4 or not correct_option:
                continue

            cleaned_options = [str(opt).strip() for opt in options]

            # Keep only questions where the correct option matches one of the options
            if correct_option not in cleaned_options:
                continue

            validated_questions.append({
                "question_text": question_text,
                "options": cleaned_options,
                "correct_option": correct_option
            })

        if not validated_questions:
            raise ValueError("No valid MCQs were produced by the model.")

        return jsonify({"questions": validated_questions[:10]})

    except Exception as e:
        print(f"ERROR in generate_mcqs: {str(e)}")
        return jsonify({"error": str(e)}), 500
if __name__ == '__main__':
    app.run(debug=True, port=5000)