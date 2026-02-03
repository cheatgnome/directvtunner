from playwright.sync_api import sync_playwright
import os

def run(playwright):
    browser = playwright.chromium.launch()
    page = browser.new_page()

    # Get absolute path to index.html
    cwd = os.getcwd()
    file_path = f"file://{cwd}/docker/app/public/index.html"

    print(f"Navigating to {file_path}")
    page.goto(file_path)

    # Wait for Alpine to initialize (it might fail fetching API but UI should render)
    page.wait_for_timeout(1000)

    # Click on Status tab
    page.click("text=Status")

    # Wait for tab switch
    page.wait_for_timeout(500)

    # Take screenshot
    page.screenshot(path="verification/status_tab.png")

    # Basic sanity check to ensure the page rendered
    print(f"Page title: {page.title()}")

    browser.close()

with sync_playwright() as playwright:
    run(playwright)
