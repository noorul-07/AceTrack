/**
 * ACETRACK - CORE GAME ENGINE
 * Handles: Matchmaking, AI Concept Extraction, Socratic Chat, and Generative MCQs
 */

// ==========================================
// 1. STATE MANAGEMENT
// ==========================================
let currentChannel = null;
let isHost = false;
let isMatchStarting = false; 
let matchQuestions = [];
let currentQuestionIndex = 0;
let matchScore = 0;

// Dynamic Multiplayer Variables
let questionTimerInterval = null;
let timeLeft = 0; 
let myAnswerStatus = 'none'; // 'none', 'correct', 'incorrect'
let opponentAnswerStatus = 'none';

// DOM Elements
const lobbySubject = document.getElementById('lobby-subject');
const lobbyChapter = document.getElementById('lobby-chapter');
const lobbyConcept = document.getElementById('lobby-concept');
const findMatchBtn = document.getElementById('find-match-btn');
const lobbyStatus = document.getElementById('lobby-status');
const gameOverlay = document.getElementById('game-overlay');

const conceptSubject = document.getElementById('concept-subject');
const conceptLesson = document.getElementById('concept-lesson');
const conceptButtonsContainer = document.getElementById('concept-buttons-container');
const conceptLoading = document.getElementById('concept-loading');
const qnaSection = document.getElementById('qna-section');
const aiProbingQuestions = document.getElementById('ai-probing-questions');
const conceptInput = document.getElementById('concept-input');
const micBtn = document.getElementById('mic-btn');
const submitConceptBtn = document.getElementById('submit-concept-btn');
const chatLog = document.getElementById('chat-log');

let selectedConcept = "";
let currentAiQuestions = "";
let chatHistoryString = "";

// ==========================================
// 2. DYNAMIC CHAPTER & CONCEPT LOADING
// ==========================================

async function loadChapters(subject, targetSelect) {
    if (!subject) {
        targetSelect.disabled = true;
        targetSelect.innerHTML = '<option value="">Select subject first</option>';
        return;
    }
    targetSelect.disabled = false;
    targetSelect.innerHTML = '<option value="">Loading...</option>';

    const { data, error } = await supabaseClient
        .from('lesson_files')
        .select('ui_lesson_name')
        .eq('grade', '12th')
        .eq('subject', subject)
        .order('ui_lesson_name', { ascending: true });

    if (error) return console.error("Error fetching chapters:", error);

    targetSelect.innerHTML = '<option value="">-- Choose Chapter --</option>';
    data.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item.ui_lesson_name;
        opt.innerText = item.ui_lesson_name;
        targetSelect.appendChild(opt);
    });
}

lobbySubject.addEventListener('change', (e) => loadChapters(e.target.value, lobbyChapter));
conceptSubject.addEventListener('change', (e) => loadChapters(e.target.value, conceptLesson));

lobbyChapter.addEventListener('change', async (e) => {
    const lesson = e.target.value;
    if (!lesson) {
        lobbyConcept.disabled = true;
        lobbyConcept.innerHTML = '<option value="">Choose chapter first</option>';
        return;
    }

    lobbyConcept.disabled = false;
    lobbyConcept.innerHTML = '<option value="">Scanning syllabus...</option>';

    try {
        const res = await fetch('get-concepts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ui_lesson_name: lesson })
        });
        const data = await res.json();
        
        lobbyConcept.innerHTML = '<option value="">-- Select a Concept --</option>';
        data.concepts.forEach(concept => {
            const opt = document.createElement('option');
            opt.value = concept;
            opt.innerText = concept;
            lobbyConcept.appendChild(opt);
        });
    } catch (err) {
        lobbyConcept.innerHTML = '<option value="">Error loading concepts</option>';
    }
});


// ==========================================
// 3. 1v1 MATCHMAKING
// ==========================================

findMatchBtn.addEventListener('click', async () => {
    const subject = lobbySubject.value;
    const chapter = lobbyChapter.value;
    const concept = lobbyConcept.value;

    if (!subject || !chapter || !concept) return alert("Please select Subject, Chapter, and Concept!");

    const roomName = `battle-${subject}-${chapter}-${concept}`.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
    findMatchBtn.disabled = true;
    lobbyStatus.classList.remove('hidden');
    isMatchStarting = false; 

    const { data: { user } } = await supabaseClient.auth.getUser();

    currentChannel = supabaseClient.channel(roomName, {
        config: { presence: { key: user.id } } 
    });

    currentChannel
        .on('presence', { event: 'sync' }, () => {
            const state = currentChannel.presenceState();
            const playerIds = Object.keys(state).sort(); 
            
            if (playerIds.length >= 2 && !isMatchStarting) {
                isMatchStarting = true; 
                if (playerIds[0] === user.id) {
                    isHost = true;
                    lobbyStatus.innerText = "Match Found! Writing AI Test...";
                    startMatchAsHost(chapter, concept, user.email);
                } else {
                    isHost = false;
                    lobbyStatus.innerText = "Match Found! Waiting for Host's AI...";
                }
            } else if (playerIds.length === 1) {
                lobbyStatus.innerText = "Waiting for an opponent...";
            }
        })
        .on('broadcast', { event: 'match_data' }, ({ payload }) => {
            if (!isHost) {
                matchQuestions = payload.questions;
                initiateGameUI(payload.hostEmail);
            }
        })
        .on('broadcast', { event: 'player_answered' }, ({ payload }) => handleOpponentAnswer(payload))
        .subscribe(async (status) => {
            if (status === 'SUBSCRIBED') await currentChannel.track({ email: user.email });
        });
});

async function startMatchAsHost(chapter, concept, myEmail) {
    try {
        const res = await fetch('generate-mcqs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ui_lesson_name: chapter, concept: concept })
        });
        
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        currentChannel.send({
            type: 'broadcast',
            event: 'match_data',
            payload: { questions: data.questions, hostEmail: myEmail }
        });

        matchQuestions = data.questions;
        initiateGameUI(myEmail);
        
    } catch (err) {
        alert("The AI failed to generate the test. Please try again.");
        location.reload();
    }
}

function initiateGameUI(opponentEmail) {
    gameOverlay.classList.remove('hidden');
    document.getElementById('opponent-name').innerText = `VS: ${opponentEmail}`;
    
    setTimeout(() => {
        document.getElementById('game-setup-ui').classList.add('hidden');
        document.getElementById('active-question-ui').classList.remove('hidden');
        startTriviaLoop();
    }, 3000);
}


// ==========================================
// 4. FRIENDS MODE (DIRECT INVITES)
// ==========================================
let globalInviteChannel = null;
let currentMyEmail = null;
let inviteTimeout = null;
let pendingRoomName = null;
let pendingHostEmail = null;

const friendEmailInput = document.getElementById('friend-email-input');
const inviteFriendBtn = document.getElementById('invite-friend-btn');
const inviteStatus = document.getElementById('invite-status');
const inviteModal = document.getElementById('incoming-invite-modal');

async function loadUserProfile() {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;

    // Display their email (e.g., "student_104")
    document.getElementById('user-display-email').innerText = user.email.split('@')[0];

    // FIX: Using .maybeSingle() instead of .single() prevents the 406 crash
    // if the user's profile row hasn't been created in the database yet.
    const { data: profile, error } = await supabaseClient
        .from('profiles')
        .select('global_rating')
        .eq('id', user.id)
        .maybeSingle();

    // Check if profile exists and has a rating
    if (profile && profile.global_rating !== null) {
        document.getElementById('user-display-rating').innerText = `Rating: ${profile.global_rating}`;
    } else {
        // Fallback base rating if they are brand new
        document.getElementById('user-display-rating').innerText = `Rating: 400`;
    }
}
async function initializeGlobalListener() {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;
    currentMyEmail = user.email;

    globalInviteChannel = supabaseClient.channel('global-invites');
    globalInviteChannel.on('broadcast', { event: 'direct_invite' }, ({ payload }) => {
        if (payload.targetEmail === currentMyEmail) {
            handleIncomingInvite(payload.hostEmail, payload.roomName);
        }
    }).subscribe();
}

inviteFriendBtn.addEventListener('click', async () => {
    const targetEmail = friendEmailInput.value.trim();
    const chapter = lobbyChapter.value;
    const concept = lobbyConcept.value;

    if (!targetEmail || !chapter || !concept) return alert("Select Chapter, Concept, and Friend's Email!");
    if (targetEmail === currentMyEmail) return alert("You can't challenge yourself!");

    const privateRoomName = `private-${Date.now()}`;
    
    inviteStatus.innerText = "Sending invite... waiting 60s for reply.";
    inviteStatus.classList.remove('hidden');
    inviteFriendBtn.disabled = true;

    setupPrivateMatchRoom(privateRoomName, chapter, concept);

    globalInviteChannel.send({
        type: 'broadcast',
        event: 'direct_invite',
        payload: { hostEmail: currentMyEmail, targetEmail: targetEmail, roomName: privateRoomName }
    });

    setTimeout(() => {
        if (inviteStatus.innerText.includes("waiting")) {
            inviteStatus.innerText = "Invite expired.";
            inviteFriendBtn.disabled = false;
            if (currentChannel) supabaseClient.removeChannel(currentChannel);
        }
    }, 60000);
});

function handleIncomingInvite(hostEmail, roomName) {
    document.getElementById('inviter-id').innerText = hostEmail;
    pendingRoomName = roomName;
    pendingHostEmail = hostEmail;
    
    inviteModal.classList.remove('translate-x-[150%]');
    setTimeout(() => { document.getElementById('invite-timer-bar').style.width = '0%'; }, 100);
    inviteTimeout = setTimeout(() => { declineInvite(); }, 60000);
}

function declineInvite() {
    clearTimeout(inviteTimeout);
    inviteModal.classList.add('translate-x-[150%]');
    document.getElementById('invite-timer-bar').style.width = '100%';
    pendingRoomName = null;
}

document.getElementById('decline-invite-btn').addEventListener('click', declineInvite);
document.getElementById('accept-invite-btn').addEventListener('click', () => {
    clearTimeout(inviteTimeout);
    inviteModal.classList.add('translate-x-[150%]');
    joinPrivateMatchRoom(pendingRoomName, pendingHostEmail);
});

function setupPrivateMatchRoom(roomName, chapter, concept) {
    currentChannel = supabaseClient.channel(roomName, { config: { presence: { key: currentMyEmail } } });
    
    currentChannel.on('presence', { event: 'sync' }, () => {
        const players = Object.keys(currentChannel.presenceState());
        if (players.length >= 2 && !isMatchStarting) {
            isMatchStarting = true;
            isHost = true;
            inviteStatus.innerText = "Friend joined! Generating AI Test...";
            startMatchAsHost(chapter, concept, currentMyEmail);
        }
    })
    .on('broadcast', { event: 'player_answered' }, ({ payload }) => handleOpponentAnswer(payload))
    .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') await currentChannel.track({ email: currentMyEmail });
    });
}

function joinPrivateMatchRoom(roomName, hostEmail) {
    currentChannel = supabaseClient.channel(roomName, { config: { presence: { key: currentMyEmail } } });
    
    currentChannel.on('broadcast', { event: 'match_data' }, ({ payload }) => {
        isHost = false;
        matchQuestions = payload.questions;
        initiateGameUI(payload.hostEmail);
    })
    .on('broadcast', { event: 'player_answered' }, ({ payload }) => handleOpponentAnswer(payload))
    .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') await currentChannel.track({ email: currentMyEmail });
    });
}

// ==========================================
// 5. SOCRATIC CONCEPT CORRECTION
// ==========================================

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-IN';
    micBtn.addEventListener('click', () => {
        recognition.start();
        micBtn.innerHTML = "🔴 Listening...";
    });
    recognition.onresult = (event) => {
        conceptInput.value = event.results[0][0].transcript;
        micBtn.innerHTML = "🎤 Voice";
    };
}

function appendChatMessage(sender, message) {
    chatLog.classList.remove('hidden');
    const msgDiv = document.createElement('div');
    msgDiv.className = `max-w-[85%] p-3 rounded-2xl text-sm ${sender === 'Student' ? 'bg-blue-600 text-white self-end rounded-tr-sm' : 'bg-green-50 text-green-900 border border-green-100 self-start rounded-tl-sm'}`;
    
    const formattedMessage = message.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    msgDiv.innerHTML = `<strong>${sender}:</strong><br> ${formattedMessage}`;
    chatLog.appendChild(msgDiv);
    
    if (window.MathJax) MathJax.typesetPromise([msgDiv]);
    chatLog.scrollTop = chatLog.scrollHeight;
}

conceptLesson.addEventListener('change', async (e) => {
    const lesson = e.target.value;
    if (!lesson) return;

    conceptButtonsContainer.innerHTML = '';
    conceptButtonsContainer.classList.add('hidden');
    qnaSection.classList.add('hidden');
    chatLog.innerHTML = "";
    chatLog.classList.add('hidden');
    chatHistoryString = "";
    conceptLoading.classList.remove('hidden');

    try {
        const res = await fetch('get-concepts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ui_lesson_name: lesson })
        });
        const data = await res.json();
        
        conceptLoading.classList.add('hidden');
        conceptButtonsContainer.classList.remove('hidden');

data.concepts.forEach(concept => {
            const btn = document.createElement('button');
            btn.innerText = concept;
            // NEW DARK MODE STYLING: Slate background, light text, indigo hover
            btn.className = "text-xs font-bold px-4 py-2 bg-slate-800 text-slate-300 hover:bg-indigo-500/20 hover:text-indigo-300 border border-slate-700 hover:border-indigo-500/50 rounded-full transition-all";
            btn.onclick = () => loadQuestionsForConcept(lesson, concept, btn);
            conceptButtonsContainer.appendChild(btn);
        });
        } catch (err) {
        conceptLoading.innerText = "Failed to load concepts.";
    }
});

async function loadQuestionsForConcept(lesson, concept, clickedBtn) {
    selectedConcept = concept;
    chatHistoryString = "";
    chatLog.innerHTML = "";
    chatLog.classList.add('hidden');
    submitConceptBtn.innerText = "EVALUATE";
    submitConceptBtn.disabled = false;
    
    document.querySelectorAll('#concept-buttons-container button').forEach(b => {
        b.classList.remove('bg-blue-500', 'text-white');
        b.classList.add('bg-slate-100', 'hover:bg-blue-100', 'hover:text-blue-700');
    });
    clickedBtn.classList.add('bg-blue-500', 'text-white');
    clickedBtn.classList.remove('bg-slate-100', 'hover:bg-blue-100', 'hover:text-blue-700');

    // Reset all buttons to the default dark mode style
    document.querySelectorAll('#concept-buttons-container button').forEach(b => {
        b.className = "text-xs font-bold px-4 py-2 bg-slate-800 text-slate-300 hover:bg-indigo-500/20 hover:text-indigo-300 border border-slate-700 hover:border-indigo-500/50 rounded-full transition-all";
    });
    
    // Highlight the newly clicked button with bright Indigo
    clickedBtn.className = "text-xs font-bold px-4 py-2 bg-indigo-600 text-white border border-indigo-500 rounded-full transition-all shadow-lg shadow-indigo-500/20";
    
    qnaSection.classList.remove('hidden');
    aiProbingQuestions.innerHTML = `<span class="animate-pulse">Generating analytical questions for '${concept}'...</span>`;
    conceptInput.value = ""; 

    try {
        const res = await fetch('generate-questions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ui_lesson_name: lesson, concept: concept })
        });
        const data = await res.json();
        currentAiQuestions = data.questions;
        aiProbingQuestions.innerHTML = `<p class="font-bold mb-2">Defend your understanding:</p>` + currentAiQuestions.replace(/\n/g, '<br>');
        
        if (window.MathJax) MathJax.typesetPromise([aiProbingQuestions]);
    } catch (err) {
        aiProbingQuestions.innerText = "Failed to generate questions.";
    }
}

submitConceptBtn.addEventListener('click', async () => {
    const lesson = conceptLesson.value;
    const answer = conceptInput.value.trim();

    if (!answer || !selectedConcept) return alert("Please type or speak an answer first!");

    appendChatMessage("Student", answer);
    conceptInput.value = ""; 
    submitConceptBtn.innerText = "SENDING...";
    submitConceptBtn.disabled = true;

    const typingBubble = document.createElement('div');
    typingBubble.className = "max-w-[85%] p-3 rounded-2xl text-sm bg-green-50 text-green-900 self-start rounded-tl-sm animate-pulse";
    typingBubble.innerText = "AceTrack AI is typing...";
    chatLog.appendChild(typingBubble);
    chatLog.scrollTop = chatLog.scrollHeight;

    try {
        const res = await fetch('evaluate-concept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ui_lesson_name: lesson, concept: selectedConcept,
                aiQuestions: currentAiQuestions, studentAnswer: answer,
                chatHistory: chatHistoryString
            })
        });
        const data = await res.json();
        chatLog.removeChild(typingBubble);

        if (data.error) throw new Error(data.error);

        appendChatMessage("AceTrack Tutor", data.response);
        chatHistoryString += `\nStudent: ${answer}\nTutor: ${data.response}\n`;

        submitConceptBtn.innerText = "ASK FOLLOW-UP";
        submitConceptBtn.disabled = false;

    } catch (err) {
        if(chatLog.contains(typingBubble)) chatLog.removeChild(typingBubble);
        appendChatMessage("System Info", "Error: Backend unreachable.");
        submitConceptBtn.innerText = "RETRY";
        submitConceptBtn.disabled = false;
    }
});


// ==========================================
// 6. DYNAMIC MULTIPLAYER GAME LOOP
// ==========================================

// --- AUDIO ENGINE ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playTickSound() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.type = 'sine'; 
    osc.frequency.setValueAtTime(1200, audioCtx.currentTime); 
    gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime); 
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1); 
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
}

function playBuzzerSound() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.type = 'sawtooth'; 
    osc.frequency.setValueAtTime(250, audioCtx.currentTime); 
    gainNode.gain.setValueAtTime(0.4, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.5);
}
// -------------------------

function startTriviaLoop() {
    currentQuestionIndex = 0;
    matchScore = 0;
    renderMatchQuestion();
}

function renderMatchQuestion() {
    if (questionTimerInterval) clearInterval(questionTimerInterval);

    const q = matchQuestions[currentQuestionIndex];
    const container = document.getElementById('active-question-ui');
    
    myAnswerStatus = 'none';
    opponentAnswerStatus = 'none';
    timeLeft = 0; // Timer waits until someone acts

    container.innerHTML = `
        <div class="mb-2 flex justify-between items-center font-bold text-blue-600 border-b border-slate-100 pb-2 h-10">
            <span>Question ${currentQuestionIndex + 1}/10</span>
            
            <div id="match-timer-container" class="hidden flex items-center gap-2">
                <span id="timer-label" class="text-xs uppercase tracking-widest font-black"></span>
                <span id="match-timer" class="text-2xl font-black px-3 py-1 rounded-lg"></span>
            </div>
        </div>
        
        <div id="match-status-text" class="hidden text-center font-bold text-sm mb-4 p-2 rounded-lg transition-all"></div>
        
        <p class="text-xl font-bold mb-6 text-slate-800">${q.question_text}</p>
        <div class="grid grid-cols-1 gap-3">
            ${q.options.map((opt) => `
                <button onclick="submitMatchAnswer(this, '${opt.replace(/'/g, "\\'")}', '${q.correct_option.replace(/'/g, "\\'")}')" class="p-4 border-2 rounded-xl hover:bg-blue-50 transition text-left font-semibold text-slate-700 bg-white">
                    ${opt}
                </button>
            `).join('')}
        </div>
        <div class="mt-6 flex justify-between text-sm font-black text-slate-400 uppercase tracking-wider">
            <span>Score: <span id="my-score-display" class="text-blue-600 text-lg ml-1">${matchScore}</span></span>
        </div>
    `;
    
    if (window.MathJax) MathJax.typesetPromise([container]);
}

// Replace these 3 functions inside your game.js (Section 6)

function startDynamicTimer(seconds, mode) {
    if (questionTimerInterval) clearInterval(questionTimerInterval);
    
    timeLeft = seconds;
    const container = document.getElementById('match-timer-container');
    const timerLabel = document.getElementById('timer-label');
    const timerEl = document.getElementById('match-timer');
    
    container.classList.remove('hidden');

    // ACTIVE TIMERS (For the person who still needs to answer)
    if (mode === 'panic') {
        timerLabel.innerText = "SUDDEN DEATH";
        timerLabel.className = "text-xs uppercase tracking-widest text-red-500 font-black animate-pulse";
        timerEl.className = "text-2xl font-black bg-red-100 text-red-600 px-3 py-1 rounded-lg";
    } else if (mode === 'focus') {
        timerLabel.innerText = "STEAL OPPORTUNITY";
        timerLabel.className = "text-xs uppercase tracking-widest text-indigo-500 font-black animate-pulse";
        timerEl.className = "text-2xl font-black bg-indigo-100 text-indigo-600 px-3 py-1 rounded-lg";
    } 
    // PASSIVE TIMER (For the person who already answered and is waiting)
    else if (mode === 'waiting') {
        timerLabel.innerText = "WAITING FOR OPPONENT...";
        timerLabel.className = "text-xs uppercase tracking-widest text-slate-400 font-bold";
        timerEl.className = "text-2xl font-black bg-slate-100 text-slate-500 px-3 py-1 rounded-lg";
    }

    timerEl.innerText = `${timeLeft}s`;

    questionTimerInterval = setInterval(() => {
        timeLeft--;
        if (timerEl) timerEl.innerText = `${timeLeft}s`;

        // Only play ticking sound if it's an ACTIVE timer (you need to answer)
        if ((mode === 'panic' || mode === 'focus') && timeLeft > 0 && timeLeft <= 5) {
            playTickSound(); 
        }

        if (timeLeft <= 0) {
            clearInterval(questionTimerInterval);
            disableAllMatchButtons();
            
            // Only play buzzer if I actually missed my window to answer
            if (myAnswerStatus === 'none') {
                playBuzzerSound();
                const statusText = document.getElementById('match-status-text');
                statusText.innerText = "Time's up! 0 Points.";
                statusText.className = "text-center font-bold text-sm mb-4 p-2 rounded-lg bg-red-50 text-red-600";
                statusText.classList.remove('hidden');
            }
            
            setTimeout(() => nextQuestion(), 2000);
        }
    }, 1000);
}

function submitMatchAnswer(btnElement, choice, correctOption) {
    if (myAnswerStatus !== 'none') return; // Prevent double clicks

    const correct = choice === correctOption;
    myAnswerStatus = correct ? 'correct' : 'incorrect';
    
    const statusText = document.getElementById('match-status-text');
    statusText.classList.remove('hidden');

    if (correct) {
        btnElement.classList.add('bg-green-500', 'text-white', 'border-green-600');
        
        if (opponentAnswerStatus === 'none') {
            // SCENARIO 1: You got it first! You wait passively.
            matchScore += 5;
            statusText.innerText = "FIRST BLOOD! +5 Points.";
            statusText.className = "text-center font-bold text-sm mb-4 p-2 rounded-lg bg-green-100 text-green-700";
            startDynamicTimer(5, 'waiting'); // 5s passive wait
        } else if (opponentAnswerStatus === 'incorrect') {
            // SCENARIO 2: Opponent missed it first, you stole it!
            matchScore += 5;
            statusText.innerText = "CLUTCH STEAL! +5 Points.";
            statusText.className = "text-center font-bold text-sm mb-4 p-2 rounded-lg bg-indigo-100 text-indigo-700";
            clearInterval(questionTimerInterval);
            setTimeout(() => nextQuestion(), 2000);
        } else {
            // SCENARIO 3: Opponent got it first, you survived sudden death
            matchScore += 3;
            statusText.innerText = "Correct! +3 Points (Opponent was faster).";
            statusText.className = "text-center font-bold text-sm mb-4 p-2 rounded-lg bg-green-50 text-green-600";
            clearInterval(questionTimerInterval);
            setTimeout(() => nextQuestion(), 2000);
        }
    } else {
        // You got it wrong
        btnElement.classList.add('bg-red-500', 'text-white', 'border-red-600');
        
        matchScore -= 1; // Apply the penalty!
        
        if (opponentAnswerStatus === 'none') {
            statusText.innerText = "Incorrect! -1 Point. Opponent gets 20s to steal.";
            statusText.className = "text-center font-bold text-sm mb-4 p-2 rounded-lg bg-red-950/50 text-red-400 border border-red-900/50";
            startDynamicTimer(20, 'focus'); 
        } else {
            statusText.innerText = "Incorrect! -1 Point.";
            statusText.className = "text-center font-bold text-sm mb-4 p-2 rounded-lg bg-red-950/50 text-red-400 border border-red-900/50";
            clearInterval(questionTimerInterval);
            setTimeout(() => nextQuestion(), 2000);
        }
    }

    document.getElementById('my-score-display').innerText = matchScore;
    disableAllMatchButtons();

    currentChannel.send({
        type: 'broadcast',
        event: 'player_answered',
        payload: { questionIndex: currentQuestionIndex, isCorrect: correct }
    });
}

function handleOpponentAnswer(payload) {
    if (payload.questionIndex !== currentQuestionIndex) return; 

    opponentAnswerStatus = payload.isCorrect ? 'correct' : 'incorrect';
    const statusText = document.getElementById('match-status-text');

    if (myAnswerStatus === 'none') {
        statusText.classList.remove('hidden');
        
        if (payload.isCorrect) {
            // Opponent got it right first. YOU have 5s. (ACTIVE)
            statusText.innerText = "Opponent got it right! You have 5 SECONDS!";
            statusText.className = "text-center font-bold text-sm mb-4 p-2 rounded-lg bg-red-100 text-red-600 animate-pulse";
            startDynamicTimer(5, 'panic');
        } else {
            // Opponent missed first! YOU have 20s to steal. (ACTIVE)
            statusText.innerText = "Opponent guessed incorrectly! You have 20s to STEAL!";
            statusText.className = "text-center font-bold text-sm mb-4 p-2 rounded-lg bg-indigo-100 text-indigo-700 animate-pulse";
            startDynamicTimer(20, 'focus');
        }
    } else {
        // We both answered. Move on.
        clearInterval(questionTimerInterval);
        setTimeout(() => nextQuestion(), 2000);
    }
}
function disableAllMatchButtons() {
    const allBtns = document.querySelectorAll('#active-question-ui button');
    allBtns.forEach(b => b.disabled = true);
}

function nextQuestion() {
    if (currentQuestionIndex < 9) {
        currentQuestionIndex++;
        renderMatchQuestion();
    } else {
        finishMatch();
    }
}

async function finishMatch() {
    document.getElementById('active-question-ui').innerHTML = `
        <div class="text-center">
            <h2 class="text-4xl font-black mb-2 text-blue-600 italic">MATCH OVER!</h2>
            <p class="text-xl mb-8 font-bold text-slate-600">You scored <span class="text-blue-600 text-3xl">${matchScore}</span> points.</p>
            <button onclick="location.reload()" class="bg-blue-600 text-white px-8 py-4 rounded-xl font-black shadow-lg shadow-blue-200 hover:scale-105 transition-transform">RETURN TO LOBBY</button>
        </div>
    `;
    
    const { data: { user } } = await supabaseClient.auth.getUser();
    const { data: profile } = await supabaseClient.from('profiles').select('*').eq('id', user.id).single();
    
    await supabaseClient.from('profiles').update({
        global_rating: profile.global_rating + matchScore,
        current_streak: profile.current_streak + 1
    }).eq('id', user.id);
}
supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session) {
        initializeGlobalListener();
        loadUserProfile(); // Load the rating when they log in!
    }
});