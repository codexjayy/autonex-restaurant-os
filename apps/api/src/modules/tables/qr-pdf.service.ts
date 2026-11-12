import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';

export interface TableQrCardInput {
  outletName: string;
  tableNumber: string;
  label: string | null;
  qrVersion: number;
  qrUrl: string;
}

@Injectable()
export class QrPdfService {
  buildQrUrl(appUrl: string, rawToken: string): string {
    return `${appUrl.replace(/\/+$/, '')}/t/${rawToken}`;
  }

  private async renderQrPng(qrUrl: string): Promise<Buffer> {
    return QRCode.toBuffer(qrUrl, {
      type: 'png',
      width: 300,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
  }

  private collectPdfBuffer(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 36,
        info: {
          Title: 'AutoNex Table QR Codes',
          Producer: 'AutoNex Restaurant OS',
        },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      draw(doc);
      doc.end();
    });
  }

  async buildSingleTableQrPdf(card: TableQrCardInput): Promise<Buffer> {
    const qrPng = await this.renderQrPng(card.qrUrl);

    return this.collectPdfBuffer((doc) => {
      const pageWidth = doc.page.width;
      const cardWidth = 340;
      const cardHeight = 440;
      const cardX = (pageWidth - cardWidth) / 2;
      const cardY = 120;

      doc
        .roundedRect(cardX, cardY, cardWidth, cardHeight, 14)
        .lineWidth(1.5)
        .strokeColor('#1F2937')
        .stroke();

      doc
        .fillColor('#111827')
        .font('Helvetica-Bold')
        .fontSize(20)
        .text(card.outletName, cardX + 20, cardY + 26, {
          width: cardWidth - 40,
          align: 'center',
        });

      doc
        .fillColor('#EA580C')
        .font('Helvetica-Bold')
        .fontSize(26)
        .text(`Table ${card.tableNumber}`, cardX + 20, cardY + 60, {
          width: cardWidth - 40,
          align: 'center',
        });

      if (card.label) {
        doc
          .fillColor('#4B5563')
          .font('Helvetica')
          .fontSize(12)
          .text(card.label, cardX + 20, cardY + 92, {
            width: cardWidth - 40,
            align: 'center',
          });
      }

      const qrSize = 210;
      const qrX = cardX + (cardWidth - qrSize) / 2;
      const qrY = cardY + 124;
      doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

      doc
        .fillColor('#111827')
        .font('Helvetica-Bold')
        .fontSize(13)
        .text('Scan QR to view menu', cardX + 20, qrY + qrSize + 22, {
          width: cardWidth - 40,
          align: 'center',
        });

      doc
        .fillColor('#6B7280')
        .font('Helvetica')
        .fontSize(9)
        .text(`AutoNex Restaurant OS • QR v${card.qrVersion}`, cardX + 20, cardY + cardHeight - 30, {
          width: cardWidth - 40,
          align: 'center',
        });
    });
  }

  async buildBulkTableQrPdf(cards: TableQrCardInput[]): Promise<Buffer> {
    const rendered = await Promise.all(
      cards.map(async (card) => ({
        card,
        qrPng: await this.renderQrPng(card.qrUrl),
      })),
    );

    return this.collectPdfBuffer((doc) => {
      const margin = 36;
      const gapX = 18;
      const gapY = 18;
      const cols = 2;
      const rows = 3;
      const perPage = cols * rows;
      const usableWidth = doc.page.width - margin * 2;
      const usableHeight = doc.page.height - margin * 2 - 24;
      const cardWidth = (usableWidth - gapX * (cols - 1)) / cols;
      const cardHeight = (usableHeight - gapY * (rows - 1)) / rows;

      rendered.forEach(({ card, qrPng }, index) => {
        if (index > 0 && index % perPage === 0) {
          doc.addPage();
        }

        const slot = index % perPage;
        if (slot === 0) {
          doc
            .fillColor('#6B7280')
            .font('Helvetica')
            .fontSize(9)
            .text(`${card.outletName} — Table QR Print Sheet`, margin, margin - 14, {
              width: usableWidth,
              align: 'right',
            });
        }

        const col = slot % cols;
        const row = Math.floor(slot / cols);
        const x = margin + col * (cardWidth + gapX);
        const y = margin + 8 + row * (cardHeight + gapY);

        doc
          .roundedRect(x, y, cardWidth, cardHeight, 10)
          .lineWidth(1)
          .strokeColor('#CBD5E1')
          .stroke();

        doc
          .fillColor('#111827')
          .font('Helvetica-Bold')
          .fontSize(12)
          .text(card.outletName, x + 10, y + 12, {
            width: cardWidth - 20,
            align: 'center',
            ellipsis: true,
          });

        doc
          .fillColor('#EA580C')
          .font('Helvetica-Bold')
          .fontSize(16)
          .text(`Table ${card.tableNumber}`, x + 10, y + 30, {
            width: cardWidth - 20,
            align: 'center',
          });

        if (card.label) {
          doc
            .fillColor('#4B5563')
            .font('Helvetica')
            .fontSize(9)
            .text(card.label, x + 10, y + 49, {
              width: cardWidth - 20,
              align: 'center',
              ellipsis: true,
            });
        }

        const qrSize = Math.min(cardWidth - 48, 128);
        const qrX = x + (cardWidth - qrSize) / 2;
        const qrY = y + 66;
        doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

        doc
          .fillColor('#1F2937')
          .font('Helvetica-Bold')
          .fontSize(10)
          .text('Scan to view menu', x + 10, qrY + qrSize + 8, {
            width: cardWidth - 20,
            align: 'center',
          });

        doc
          .fillColor('#6B7280')
          .font('Helvetica')
          .fontSize(8)
          .text(`QR v${card.qrVersion}`, x + 10, y + cardHeight - 18, {
            width: cardWidth - 20,
            align: 'center',
          });
      });
    });
  }
}

