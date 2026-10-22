![IT-Exam Scraper Banner](IT-Exam_Scraper_Banner.png)

# ITExamAnswer Scraper Extension

A lightweight browser extension that scrapes exam question-and-answer sets directly from ITExamAnswer pages and formats them into `.xlsx` spreadsheets (ready for Wayground/Quizizz import) or `.txt` study summaries.

---

## 📌 Background & Context

This project was originally built in Python using Playwright as a terminal-only CLI scraper. While effective, running terminal scripts required local Python installations, dependencies, and headless browser sessions. 

To make the workflow faster and accessible without opening a terminal, the scraper was completely rebuilt in pure JavaScript as a zero-build Manifest V3 browser extension. It runs directly inside your browser with a single click.

---

## ⚙️ How It Works

1. **DOM Parsing:** When activated, the extension inspects the target ITExamAnswer page and extracts question prompts, multiple-choice options, correct answers, and associated diagram/figure images.
2. **Export Formatting:**
   - **Spreadsheet (`.xlsx`):** Formatted to match Wayground/Quizizz assessment import standards.
   - **Text (`.txt`):** Generates a clean, readable review sheet for personal offline study.
3. **Image Scraping:** Optionally scrapes and tags image references directly tied to questions.

---

## 🚀 How to Install

1. Clone or download this repository:
   - Click the green **Code** button at the top of the GitHub page -> **Download ZIP**.
   - Extract the `.zip` archive on your computer.
2. Open Google Chrome (or Edge/Brave) and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle in the upper right.
4. Click **Load unpacked** in the upper left.
5. Select the **`extension/`** folder (do not select the repository root).
6. Pin the extension to your toolbar by clicking the puzzle icon in Chrome.

---

## 📖 How to Use

1. Navigate to the target **ITExamAnswer** page containing the questions and answers.
2. Click the **ITExamAnswer Scraper** icon in your toolbar.
3. Configure your export preferences:
   - Choose **`.xlsx`** to create a spreadsheet for Wayground/Quizizz.
   - Choose **`.txt`** for a personal study notes file.
   - Toggle whether you want to scrape question images.
4. Click **Extract / Download**.

---

### Importing Your `.xlsx` File to Wayground

To convert the exported spreadsheet into an interactive assessment for you and your peers:

1. Go to [https://wayground.com/explore/admin](https://wayground.com/explore/admin) (log in if needed).
2. Click **Create a resource**.
3. Select **Assessment** as your study material type.
4. Scroll down to the **Import existing files** section and select **Spreadsheet** as the file type.
5. Drag and drop the downloaded `.xlsx` file into the import area.
6. Review the imported questions and publish the quiz to study collaboratively.

---

## ⚠️ Notes & Disclaimer

- **Vibe-Coded Architecture:** This extension was heavily vibe-coded. While tested on primary question formats, DOM layouts on exam sites vary. If you encounter edge cases or parsing bugs, please open an Issue with the target page URL and question number.
- **Fair Use:** This tool is intended for personal revision, active recall, and collaborative study. All scraped content belongs to its respective owners.
