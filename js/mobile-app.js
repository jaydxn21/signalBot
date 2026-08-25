// Mobile Navigation
document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        
        const page = this.dataset.page;
        // Show/hide pages
        document.querySelectorAll('.page-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById(`page-${page}`);
        if (panel) panel.classList.add('active');
    });
});

// Clock Update
function updateClock() {
    const now = new Date();
    document.getElementById('clock').textContent = 
        now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}
setInterval(updateClock, 1000);
updateClock();

// Bot card toggle
document.querySelectorAll('.bot-toggle-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        const card = this.closest('.bot-card');
        card.classList.toggle('running');
        this.textContent = card.classList.contains('running') ? 'Stop Bot' : 'Start Bot';
    });
});

// Add Bot
document.getElementById('btn-add-bot').addEventListener('click', function() {
    const botList = document.querySelector('.bot-list');
    const template = document.querySelector('.bot-card').cloneNode(true);
    // Reset form values
    template.querySelectorAll('input, select').forEach(el => {
        if (el.tagName === 'SELECT') el.selectedIndex = 0;
        else if (el.type !== 'checkbox') el.value = '';
    });
    botList.appendChild(template);
});