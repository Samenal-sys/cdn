// Clear all cookies
document.cookie.split(";").forEach(cookie => {
    const name = cookie.split("=")[0].trim();
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
});

// Clear localStorage
localStorage.clear();

// Redirect to www.wildwest.gg
window.location.href = "https://www.wildwest.gg";
