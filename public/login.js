let mode = 'login';
const tabs = document.querySelectorAll('.tab');
const submitBtn = document.getElementById('submit-btn');
const errorEl = document.getElementById('auth-error');
const passwordInput = document.getElementById('password');
const showPasswordBox = document.getElementById('show-password');
const strengthEl = document.getElementById('password-strength');

showPasswordBox.addEventListener('change', () => {
  passwordInput.type = showPasswordBox.checked ? 'text' : 'password';
});

function checkPasswordStrength(password) {
  const checks = {
    length: password.length >= 8,
    upper: /[A-Z]/.test(password),
    lower: /[a-z]/.test(password),
    number: /[0-9]/.test(password),
    special: /[^A-Za-z0-9]/.test(password),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  const strong = passed === 5;
  const missing = [];
  if (!checks.length) missing.push('at least 8 characters');
  if (!checks.upper) missing.push('an uppercase letter');
  if (!checks.lower) missing.push('a lowercase letter');
  if (!checks.number) missing.push('a number');
  if (!checks.special) missing.push('a special character');
  return { strong, missing };
}

passwordInput.addEventListener('input', () => {
  if (mode !== 'signup') {
    strengthEl.style.display = 'none';
    return;
  }
  const { strong, missing } = checkPasswordStrength(passwordInput.value);
  strengthEl.style.display = passwordInput.value ? 'block' : 'none';
  if (strong) {
    strengthEl.textContent = 'Strong password.';
    strengthEl.style.color = '#7fdd8f';
  } else {
    strengthEl.textContent = `Password needs: ${missing.join(', ')}.`;
    strengthEl.style.color = '#ff9fae';
  }
});

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    mode = tab.dataset.mode;
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    submitBtn.textContent = mode === 'login' ? 'Sign in' : 'Sign up';
    errorEl.textContent = '';
    strengthEl.style.display = 'none';
  });
});

submitBtn.addEventListener('click', async () => {
  errorEl.textContent = '';
  const username = document.getElementById('username').value.trim();
  const password = passwordInput.value;
  if (!username || !password) {
    errorEl.textContent = 'Enter a username and password.';
    return;
  }
  if (mode === 'signup' && !checkPasswordStrength(password).strong) {
    errorEl.textContent = 'Please choose a stronger password.';
    return;
  }
  submitBtn.disabled = true;
  try {
    const res = await fetch(`/api/auth/${mode === 'login' ? 'login' : 'signup'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    window.location.href = '/';
  } catch (err) {
    errorEl.textContent = err.message;
    submitBtn.disabled = false;
  }
});
