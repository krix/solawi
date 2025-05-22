import { Component, effect, signal, untracked } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { MatTableModule } from '@angular/material/table';
import { MatInputModule } from '@angular/material/input';
import { DecimalPipe } from '@angular/common';

interface Depot {
  name: string;
  halfShares: number;
  fullShares: number;
  shares: number;
  persons: number;
  shareFactor: number;
}

interface Item {
  name: string;
  amount: number;
  rest: number;
  shares: Share[];
}

interface Share {
  depot: Depot;
  isDepotActive: boolean;
  amountPerHalfShare: number;
  amountPerPerson: number;
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, MatTableModule, MatInputModule, DecimalPipe],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  depots = signal<Depot[]>([]);
  items = signal<Item[]>([]);
  displayedColumns: string[] = ['depot', 'half-shares', 'full-shares', 'persons', 'per-half-share-amount', 'per-person-amount'];

  constructor() {
    this.addDepot('Wiesbaden', 6, 2);
    this.addDepot('Trebur', 10, 1);
    this.addDepot('Nauheim', 7, 3);
    this.addDepot('Raunheim', 8, 2);

    this.depots().forEach(depot => this.calculateShareFactor(depot));

    this.addItem('Kohlrabi', 500);

    effect(() => {
      const items = this.items();

      untracked(() => this.calculateShares(items));
    });
  }

  private addDepot(name: string, halfShares: number, fullShares: number) {
    this.depots.set([...this.depots(), {
      name: name,
      halfShares: halfShares,
      fullShares: fullShares,
      shares: halfShares + fullShares * 2,
      persons: halfShares + fullShares,
      shareFactor: 1
    }]);
  }

  private calculateShareFactor(depot: Depot) {
    const totalShares = this.depots().reduce((previousValue, currentValue) => {
      return previousValue + currentValue.shares;
    }, 0);

    depot.shareFactor = depot.shares / totalShares;
  }

  private addItem(name: string, amount: number) {
    this.items.set([...this.items(), {
      name,
      amount,
      rest: amount,
      shares: this.depots().map(depot => {
        return {
          depot: {...depot},
          isDepotActive: true,
          amountPerHalfShare: 0,
          amountPerPerson: 0
        }
      })
    }]);
  }

  private calculateShares(items: Item[]) {
    items.forEach(item => {
      item.shares.forEach(share => {
        share.amountPerHalfShare = share.depot.shareFactor * item.amount;
      });
    });
  }
}
