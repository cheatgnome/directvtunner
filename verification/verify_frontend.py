from playwright.sync_api import sync_playwright
import time
import http.server
import socketserver
import threading
import os

# Start a simple HTTP server to serve the static files
PORT = 8080
Handler = http.server.SimpleHTTPRequestHandler

def start_server():
    os.chdir('public')
    with socketserver.TCPServer(('', PORT), Handler) as httpd:
        print('serving at port', PORT)
        httpd.serve_forever()

server_thread = threading.Thread(target=start_server)
server_thread.daemon = True
server_thread.start()

# Give server a moment to start
time.sleep(2)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto('http://localhost:8080/index.html')

    # Wait for Alpine to initialize (though without API it might be fast/broken)
    time.sleep(2)

    # Take screenshot
    page.screenshot(path='../verification/frontend.png')

    # Basic sanity check to ensure the page rendered
    print(f'Page title: {page.title()}')

    browser.close()
