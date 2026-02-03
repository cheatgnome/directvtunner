from playwright.sync_api import sync_playwright
import time
import http.server
import socketserver
import threading
import os

# Start a simple HTTP server
PORT = 8081
Handler = http.server.SimpleHTTPRequestHandler

def start_server():
    os.chdir('public')
    try:
        with socketserver.TCPServer(('', PORT), Handler) as httpd:
            print('serving at port', PORT)
            httpd.serve_forever()
    except OSError:
        pass # Port might be in use

server_thread = threading.Thread(target=start_server)
server_thread.daemon = True
server_thread.start()

time.sleep(2)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto('http://localhost:8081/index.html')

    # Click Status tab
    page.get_by_role('button', name='Status').click()

    time.sleep(1)

    # Take screenshot of status tab
    page.screenshot(path='../verification/frontend_status.png')

    content = page.content()
    if 'CinemaOS Movies' in content:
        print('FAILURE: CinemaOS Movies found in page content')
    else:
        print('SUCCESS: CinemaOS Movies NOT found in page content')

    browser.close()
