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

    # Check if CinemaOS text is present (should not be)
    content = page.content()
    if "CinemaOS Movies" in content:
        print("FAILURE: CinemaOS Movies text found in page content")
    else:
        print("SUCCESS: CinemaOS Movies text not found")

    if "TV Shows" in content:
        # Note: "TV Shows" might be in the content if I didn't remove the card completely?
        # I removed both cards.
        # But wait, "TV Shows" text might be elsewhere?
        # In index.html: <h3>TV Shows</h3> was removed.
        print("CHECK: TV Shows text found in page content?")
        # Let's check specifically for the header
        if "<h3>TV Shows</h3>" in content:
             print("FAILURE: TV Shows header found")
        else:
             print("SUCCESS: TV Shows header not found")

    browser.close()

with sync_playwright() as playwright:
    run(playwright)
