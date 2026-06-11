const fs = require('fs');
const { PDFDocument, rgb } = require('pdf-lib');

async function main() {
  const pdfDoc = await PDFDocument.create();
  
  // Add 5 pages with different text/colors to simulate scanned document
  for (let i = 1; i <= 5; i++) {
    const page = pdfDoc.addPage([600, 800]);
    
    // Draw some shapes and text
    page.drawText(`Sample Scanned Document - Page ${i}`, {
      x: 50,
      y: 700,
      size: 24,
      color: rgb(0.1, 0.2, 0.4),
    });

    page.drawText(`This is page ${i} content.`, {
      x: 50,
      y: 650,
      size: 14,
      color: rgb(0.2, 0.2, 0.2),
    });

    if (i === 3) {
      // Create a page that is mostly blank for testing auto blank detection
      page.drawText(`Almost blank page`, {
        x: 50,
        y: 750,
        size: 8,
        color: rgb(0.99, 0.99, 0.99), // extremely faint
      });
    } else {
      // Draw a colored block on other pages
      page.drawRectangle({
        x: 50,
        y: 100,
        width: 500,
        height: 400,
        color: rgb(0.95, 0.95, 0.98),
        borderColor: rgb(0.8, 0.8, 0.8),
        borderWidth: 1,
      });
    }
  }

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync('dummy.pdf', pdfBytes);
  console.log('Successfully created dummy.pdf with 5 pages!');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
