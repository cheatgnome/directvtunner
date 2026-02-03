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

    # Check for text presence
    content = page.content()
    if 'CinemaOS Movies' in content:
        print('FAILURE: CinemaOS Movies found in page content')
    else:
        print('SUCCESS: CinemaOS Movies NOT found in page content')

    if 'TV Shows' in content:
        # Note: TV Shows might be in other context?
        # The card header was <h3>TV Shows</h3>
        if '<h3>TV Shows</h3>' in content:
             print('FAILURE: TV Shows card found')
        else:
             print('SUCCESS: TV Shows card NOT found')

    browser.close()
