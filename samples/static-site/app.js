document.getElementById('clock').textContent = 'Served live at ' + new Date().toLocaleString();
setInterval(() => {
  document.getElementById('clock').textContent = 'Served live at ' + new Date().toLocaleString();
}, 1000);
