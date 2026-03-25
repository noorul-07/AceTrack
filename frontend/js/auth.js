// 1. Initialize Supabase (Using a different variable name to avoid collision)
const SUPABASE_URL = 'https://gjjgrzqjyqnphkrntspf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdqamdyenFqeXFucGhrcm50c3BmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNDU1MDksImV4cCI6MjA4OTkyMTUwOX0.sDysEzrCl5YSvCzFbkFrOhunOA5jmpGeyejm0xnIm9A';

// Change 'supabase' to 'supabaseClient'
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// DOM Elements
const authSection = document.getElementById('auth-section');
const dashboardSection = document.getElementById('dashboard-section');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login-btn');
const signupBtn = document.getElementById('signup-btn');
const toggleModeBtn = document.getElementById('toggle-auth-mode');
const authTitle = document.getElementById('auth-title');
const toggleAuthText = document.getElementById('toggle-auth-text');
const authError = document.getElementById('auth-error');
const logoutBtn = document.getElementById('logout-btn');
const userDisplayEmail = document.getElementById('user-display-email');

let isLoginMode = true;

// 2. Toggle between Login and Sign Up UI
toggleModeBtn.addEventListener('click', () => {
    isLoginMode = !isLoginMode;
    authError.classList.add('hidden');
    
    if (isLoginMode) {
        authTitle.innerText = "Login to Play";
        loginBtn.classList.remove('hidden');
        signupBtn.classList.add('hidden');
        toggleAuthText.innerText = "Don't have an account?";
        toggleModeBtn.innerText = "Sign up here";
    } else {
        authTitle.innerText = "Create an Account";
        loginBtn.classList.add('hidden');
        signupBtn.classList.remove('hidden');
        toggleAuthText.innerText = "Already have an account?";
        toggleModeBtn.innerText = "Login here";
    }
});

// 3. Handle Sign Up
signupBtn.addEventListener('click', async () => {
    const email = emailInput.value;
    const password = passwordInput.value;
    
    if (!email || !password) return showError("Please enter email and password.");

    const { data, error } = await supabaseClient.auth.signUp({
        email: email,
        password: password,
    });

    if (error) {
        showError(error.message);
    } else {
        alert("Account created! You can now log in.");
        toggleModeBtn.click(); // Switch back to login view
    }
});

// 4. Handle Login
loginBtn.addEventListener('click', async () => {
    const email = emailInput.value;
    const password = passwordInput.value;

    if (!email || !password) return showError("Please enter email and password.");

    const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: email,
        password: password,
    });

    if (error) showError(error.message);
    // UI changes are handled automatically by the auth state listener below
});

// 5. Handle Logout
logoutBtn.addEventListener('click', async () => {
    const { error } = await supabaseClient.auth.signOut();
    if (error) console.error("Logout Error:", error);
});

// Helper function to show errors
function showError(message) {
    authError.innerText = message;
    authError.classList.remove('hidden');
}

// 6. The "Brain" - Listen for Auth State Changes
// This automatically fires when the page loads or when a user logs in/out
supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session) {
        // User is logged in
        authSection.classList.add('hidden');
        dashboardSection.classList.remove('hidden');
        userDisplayEmail.innerText = session.user.email;
        
        // Clear inputs for security
        emailInput.value = '';
        passwordInput.value = '';
        authError.classList.add('hidden');
    } else {
        // User is logged out
        authSection.classList.remove('hidden');
        dashboardSection.classList.add('hidden');
        userDisplayEmail.innerText = '';
    }
});