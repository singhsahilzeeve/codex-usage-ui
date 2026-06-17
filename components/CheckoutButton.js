import React from 'react';

export default function CheckoutButton({ cart }) {
  const handleCheckout = () => {
    alert('Processing payment...');
  };

  return (
    <button 
      onClick={handleCheckout}
      className="bg-orange-600 text-white px-6 py-2 rounded"
    >
      Complete Purchase (${cart?.total || 0})
    </button>
  );
}
