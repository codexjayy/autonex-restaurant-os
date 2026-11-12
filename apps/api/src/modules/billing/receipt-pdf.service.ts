import { Injectable } from '@nestjs/common';
import {
  BillLineType,
  BillSummaryDto,
  TaxMode,
  formatInrFromPaise,
} from '@autonex/shared';
import PDFDocument from 'pdfkit';

@Injectable()
export class ReceiptPdfService {
  private collectPdfBuffer(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: [260, 720],
        margin: 16,
        info: {
          Title: 'AutoNex Tax Invoice & Receipt',
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

  async buildReceiptPdf(bill: BillSummaryDto): Promise<Buffer> {
    return this.collectPdfBuffer((doc) => {
      const width = doc.page.width - 32;

      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .text(bill.outletNameSnapshot, { align: 'center', width });

      if (bill.outletAddressSnapshot) {
        doc
          .font('Helvetica')
          .fontSize(7.5)
          .fillColor('#475569')
          .text(bill.outletAddressSnapshot, { align: 'center', width });
      }

      if (bill.gstinSnapshot) {
        doc
          .font('Helvetica-Bold')
          .fontSize(7.5)
          .fillColor('#0f172a')
          .text(`GSTIN: ${bill.gstinSnapshot}`, { align: 'center', width });
      }

      doc.moveDown(0.5);
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#0f172a')
        .text(bill.gstinSnapshot ? 'TAX INVOICE' : 'BILL OF SUPPLY / RECEIPT', {
          align: 'center',
          width,
        });

      doc.moveDown(0.4);
      doc.font('Helvetica').fontSize(8).fillColor('#1e293b');
      doc.text(`Bill No: ${bill.billNumber}`);
      doc.text(`Table: ${bill.tableNumber}${bill.tableLabel ? ` (${bill.tableLabel})` : ''}`);
      doc.text(`Status: ${bill.status}`);
      doc.text(
        `Date: ${new Date(bill.finalizedAt).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
        })}`,
      );

      this.drawDivider(doc, width);

      // Item lines header
      doc.font('Helvetica-Bold').fontSize(8);
      doc.text('ITEM / QTY', 16, doc.y, { continued: true, width: width - 64 });
      doc.text('AMOUNT', { align: 'right', width: 64 });
      doc.moveDown(0.3);

      const itemLines = bill.lines.filter((l) => l.lineType === BillLineType.ITEM);
      doc.font('Helvetica').fontSize(8);
      for (const line of itemLines) {
        const yBefore = doc.y;
        doc.text(`${line.quantity} x ${line.description}`, 16, yBefore, {
          width: width - 68,
        });
        const yAfterText = doc.y;
        doc.text(formatInrFromPaise(line.lineAmountPaise), 16 + width - 64, yBefore, {
          width: 64,
          align: 'right',
        });
        doc.y = Math.max(yAfterText, yBefore + 11);
      }

      if (
        bill.taxMode !== TaxMode.NONE &&
        bill.itemGstBreakdown &&
        bill.itemGstBreakdown.length > 0
      ) {
        const halfRateLabel = (bill.gstRateBps / 200).toFixed(2).replace(/\.00$/, '');
        this.drawDivider(doc, width);
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#0f172a');
        doc.text(`ITEM-WISE GST BREAKUP (@ ${halfRateLabel}% CGST + ${halfRateLabel}% SGST)`);
        doc.moveDown(0.2);

        const colTaxableX = 16 + width - 114;
        const colCgstX = 16 + width - 76;
        const colSgstX = 16 + width - 38;
        const hY = doc.y;
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#475569');
        doc.text('ITEM', 16, hY, { width: width - 118 });
        doc.text('TAXABLE', colTaxableX, hY, { width: 38, align: 'right' });
        doc.text('CGST', colCgstX, hY, { width: 36, align: 'right' });
        doc.text('SGST', colSgstX, hY, { width: 38, align: 'right' });
        doc.y = hY + 10;

        doc.font('Helvetica').fontSize(6.5).fillColor('#1e293b');
        for (const row of bill.itemGstBreakdown) {
          const rowY = doc.y;
          doc.text(`${row.quantity}x ${row.description}`, 16, rowY, {
            width: width - 120,
          });
          const afterNameY = doc.y;
          doc.text(formatInrFromPaise(row.taxablePaise), colTaxableX, rowY, {
            width: 38,
            align: 'right',
          });
          doc.text(formatInrFromPaise(row.cgstPaise), colCgstX, rowY, {
            width: 36,
            align: 'right',
          });
          doc.text(formatInrFromPaise(row.sgstPaise), colSgstX, rowY, {
            width: 38,
            align: 'right',
          });
          doc.y = Math.max(afterNameY, rowY + 9);
        }
      }

      this.drawDivider(doc, width);

      this.drawSummaryRow(doc, width, 'Subtotal', formatInrFromPaise(bill.subtotalPaise));
      if (bill.discountPaise > 0) {
        this.drawSummaryRow(
          doc,
          width,
          bill.discountReason ? `Discount (${bill.discountReason})` : 'Discount',
          `-${formatInrFromPaise(bill.discountPaise)}`,
        );
      }

      if (bill.taxMode !== TaxMode.NONE && (bill.cgstPaise > 0 || bill.sgstPaise > 0)) {
        const halfRate = (bill.gstRateBps / 200).toFixed(2).replace(/\.00$/, '');
        const suffix = bill.taxMode === TaxMode.INCLUSIVE ? ' (incl.)' : '';
        this.drawSummaryRow(
          doc,
          width,
          `CGST @ ${halfRate}%${suffix}`,
          formatInrFromPaise(bill.cgstPaise),
        );
        this.drawSummaryRow(
          doc,
          width,
          `SGST @ ${halfRate}%${suffix}`,
          formatInrFromPaise(bill.sgstPaise),
        );
      }

      if (bill.roundOffPaise !== 0) {
        this.drawSummaryRow(doc, width, 'Round-Off', formatInrFromPaise(bill.roundOffPaise));
      }

      this.drawDivider(doc, width);
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a');
      this.drawSummaryRow(doc, width, 'GRAND TOTAL', formatInrFromPaise(bill.totalPaise));

      const succeededPayments = bill.paymentAttempts.filter((p) => p.status === 'SUCCEEDED');
      if (succeededPayments.length > 0) {
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(7.5).text('PAYMENTS RECORDED');
        doc.font('Helvetica').fontSize(7.5);
        for (const p of succeededPayments) {
          const label = p.receiptRef ? `${p.method} (${p.receiptRef})` : p.method;
          this.drawSummaryRow(doc, width, label, formatInrFromPaise(p.amountPaise));
        }
      }

      if (bill.refundedPaise > 0) {
        doc.font('Helvetica').fontSize(7.5).fillColor('#be123c');
        this.drawSummaryRow(
          doc,
          width,
          'Refunded',
          `-${formatInrFromPaise(bill.refundedPaise)}`,
        );
      }

      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(8);
      if (bill.duePaise > 0) {
        this.drawSummaryRow(doc, width, 'BALANCE DUE', formatInrFromPaise(bill.duePaise));
      } else {
        this.drawSummaryRow(doc, width, 'NET PAID', formatInrFromPaise(bill.netPaidPaise));
      }

      doc.moveDown(0.8);
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor('#475569')
        .text('Thank you for dining with us! Powered by AutoNex.', {
          align: 'center',
          width,
        });
    });
  }

  private drawDivider(doc: PDFKit.PDFDocument, width: number) {
    doc.moveDown(0.35);
    doc
      .strokeColor('#cbd5e1')
      .lineWidth(0.75)
      .moveTo(16, doc.y)
      .lineTo(16 + width, doc.y)
      .stroke();
    doc.moveDown(0.35);
  }

  private drawSummaryRow(doc: PDFKit.PDFDocument, width: number, label: string, value: string) {
    const y = doc.y;
    doc.text(label, 16, y, { width: width - 70 });
    doc.text(value, 16 + width - 68, y, { width: 68, align: 'right' });
    doc.moveDown(0.2);
  }
}

