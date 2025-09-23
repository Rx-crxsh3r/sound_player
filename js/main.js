import { listen } from '@tauri-apps/api/event';

document.addEventListener('DOMContentLoaded', () => {
    // --- Element References ---
    const mainBar = document.getElementById('main-bar');
    const popupBox = document.getElementById('popup-box');
    const openPopupBtn = document.getElementById('open-popup-btn');
    const closePopupBtn = document.getElementById('close-popup-btn');

    // UI elements for Main Bar
    const trackTimeEl = document.getElementById('track-time');
    
    // UI elements for Popup Box
    const albumArtEl = document.getElementById('album-art');
    const trackTitleEl = document.getElementById('track-title');
    const trackArtistEl = document.getElementById('track-artist');
    const progressBarEl = document.getElementById('progress-bar');

    // --- State & Logic ---

    // Function to format time from seconds to MM:SS
    function formatTime(seconds) {
        const minutes = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }

    // Main function to update the entire UI based on media state
    function updateUI(state) {
        if (state.status === 'playing') {
            mainBar.classList.remove('idle');
            mainBar.classList.add('playing');

            // Update Main Bar
            trackTimeEl.textContent = `${formatTime(state.current_time)} / ${formatTime(state.total_time)}`;

            // Update Popup Box
            albumArtEl.src = state.album_art_url;
            trackTitleEl.textContent = state.title;
            trackArtistEl.textContent = state.artist;
            const progressPercent = (state.current_time / state.total_time) * 100;
            progressBarEl.style.width = `${progressPercent}%`;

        } else { // Idle state
            mainBar.classList.remove('playing');
            mainBar.classList.add('idle');
        }
    }

    // Listen for the 'media-update' event from the Rust backend
    listen('media-update', (event) => {
        console.log('Received media update:', event.payload);
        updateUI(event.payload);
    });
    
    // --- View Switching ---
    openPopupBtn.addEventListener('click', () => {
        mainBar.classList.add('hidden');
        popupBox.classList.remove('hidden');
    });

    closePopupBtn.addEventListener('click', () => {
        popupBox.classList.add('hidden');
        mainBar.classList.remove('hidden');
    });

    // --- Template Loading ---
    function loadTemplate(templateName) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `css/templates/${templateName}.css`;
        document.head.appendChild(link);
    }
    
    // Load the default dark template on startup
    loadTemplate('dark'); //temporaryyy
});
